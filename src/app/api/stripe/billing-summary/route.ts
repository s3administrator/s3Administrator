import { NextResponse } from "next/server"
import { communityGuard } from "@/lib/api-guard";
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import Stripe from "stripe"

function toIsoDate(unixSeconds: number | null | undefined): string | null {
  if (!unixSeconds) return null
  return new Date(unixSeconds * 1000).toISOString()
}

function getPriceId(price: string | Stripe.Price | Stripe.DeletedPrice): string | null {
  if (!price) return null
  return typeof price === "string" ? price : price.id
}

function getUnitAmount(price: string | Stripe.Price | Stripe.DeletedPrice): number | null {
  if (!price || typeof price === "string" || "deleted" in price) return null
  return price.unit_amount
}

function getCurrency(price: string | Stripe.Price | Stripe.DeletedPrice): string | null {
  if (!price || typeof price === "string" || "deleted" in price) return null
  return price.currency
}

export async function GET() {
  const _guard = communityGuard(); if (_guard) return _guard;
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const rl = rateLimitByUser(session.user.id, "billing-summary", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      stripeCustomerId: true,
      subscriptions: {
        where: { status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] } },
        orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: {
          id: true,
          stripeSubscriptionId: true,
          status: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          plan: {
            select: {
              id: true,
              name: true,
              slug: true,
              priceMonthly: true,
              stripePriceId: true,
            },
          },
        },
      },
    },
  })

  const activeSubscription = user?.subscriptions[0] ?? null
  const stripeCustomerId = user?.stripeCustomerId ?? null

  if (!stripeCustomerId) {
    return NextResponse.json({
      activeSubscription: null,
      nextPayment: null,
      scheduledUpdate: null,
      previousPayments: [],
    })
  }

  const paidInvoicesPromise = stripe.invoices.list({
    customer: stripeCustomerId,
    status: "paid",
    limit: 12,
  })

  const upcomingInvoicePromise = (async () => {
    try {
      if (activeSubscription?.stripeSubscriptionId) {
        return await stripe.invoices.createPreview({
          customer: stripeCustomerId,
          subscription: activeSubscription.stripeSubscriptionId,
        })
      }
      return await stripe.invoices.createPreview({ customer: stripeCustomerId })
    } catch (error) {
      const knownStripeFailure =
        error instanceof Stripe.errors.StripeError ||
        error instanceof Stripe.errors.StripeInvalidRequestError
      if (knownStripeFailure) {
        return null
      }
      throw error
    }
  })()

  const scheduledUpdatePromise = (async () => {
    if (!activeSubscription?.stripeSubscriptionId) return null

    try {
      const stripeSub = await stripe.subscriptions.retrieve(activeSubscription.stripeSubscriptionId)
      const scheduleId =
        typeof stripeSub.schedule === "string" ? stripeSub.schedule : stripeSub.schedule?.id
      if (!scheduleId) return null

      const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
      if (schedule.status !== "active" && schedule.status !== "not_started") {
        return null
      }

      const currentPriceId = stripeSub.items.data[0]?.price?.id
      const currentPhaseEnd = schedule.current_phase?.end_date ?? Math.floor(Date.now() / 1000)

      const nextPhase = schedule.phases
        .filter((phase) => phase.start_date >= currentPhaseEnd)
        .sort((a, b) => a.start_date - b.start_date)
        .find((phase) => {
          const candidatePrice = phase.items[0]?.price
          const candidatePriceId = candidatePrice ? getPriceId(candidatePrice) : null
          return !!candidatePriceId && candidatePriceId !== currentPriceId
        })

      if (!nextPhase) return null

      const nextPhaseItem = nextPhase.items[0]
      if (!nextPhaseItem?.price) return null

      const nextPriceId = getPriceId(nextPhaseItem.price)
      if (!nextPriceId) return null

      const nextPlan =
        (await prisma.plan.findUnique({
          where: { stripePriceId: nextPriceId },
          select: { id: true, name: true, slug: true, priceMonthly: true },
        })) ?? null

      return {
        effectiveAt: toIsoDate(nextPhase.start_date),
        targetPlanId: nextPlan?.id ?? null,
        targetPlanName: nextPlan?.name ?? "Scheduled plan update",
        targetPlanSlug: nextPlan?.slug ?? null,
        targetPriceMonthly: nextPlan?.priceMonthly ?? getUnitAmount(nextPhaseItem.price),
        currency: getCurrency(nextPhaseItem.price),
      }
    } catch (error) {
      const missingSchedule =
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.code === "resource_missing"
      if (missingSchedule) return null
      throw error
    }
  })()

  const [paidInvoices, upcomingInvoice, scheduledUpdate] = await Promise.all([
    paidInvoicesPromise,
    upcomingInvoicePromise,
    scheduledUpdatePromise,
  ])

  return NextResponse.json({
    activeSubscription: activeSubscription
      ? {
          id: activeSubscription.id,
          status: activeSubscription.status,
          planName: activeSubscription.plan.name,
          planSlug: activeSubscription.plan.slug,
          priceMonthly: activeSubscription.plan.priceMonthly,
          currentPeriodStart: activeSubscription.currentPeriodStart.toISOString(),
          currentPeriodEnd: activeSubscription.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: activeSubscription.cancelAtPeriodEnd,
        }
      : null,
    nextPayment: upcomingInvoice
      ? {
          amountDue: upcomingInvoice.amount_due,
          amountRemaining: upcomingInvoice.amount_remaining,
          currency: upcomingInvoice.currency,
          dueAt: toIsoDate(
            upcomingInvoice.next_payment_attempt ??
              upcomingInvoice.due_date ??
              upcomingInvoice.period_end,
          ),
          periodStart: toIsoDate(upcomingInvoice.period_start),
          periodEnd: toIsoDate(upcomingInvoice.period_end),
        }
      : null,
    scheduledUpdate,
    previousPayments: paidInvoices.data.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      paidAt: toIsoDate(invoice.status_transitions.paid_at ?? invoice.created),
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdf: invoice.invoice_pdf ?? null,
      status: invoice.status,
    })),
  })
}
