import { NextRequest, NextResponse } from "next/server"
import { communityGuard } from "@/lib/api-guard";
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"
import { absoluteUrl } from "@/lib/site-url"
import Stripe from "stripe"

function getPeriodDates(sub: Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>) {
  const item = sub.items.data[0]
  return {
    start: new Date((item?.current_period_start ?? 0) * 1000),
    end: new Date((item?.current_period_end ?? 0) * 1000),
  }
}

function getScheduleId(schedule: string | Stripe.SubscriptionSchedule | null): string | null {
  if (!schedule) return null
  return typeof schedule === "string" ? schedule : schedule.id
}

async function releaseScheduleIfActive(schedule: string | Stripe.SubscriptionSchedule | null) {
  const scheduleId = getScheduleId(schedule)
  if (!scheduleId) return

  try {
    const existingSchedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
    if (existingSchedule.status === "active" || existingSchedule.status === "not_started") {
      await stripe.subscriptionSchedules.release(scheduleId)
    }
  } catch (error) {
    const missingSchedule =
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === "resource_missing"
    if (!missingSchedule) {
      throw error
    }
  }
}

async function getOrCreateActiveSchedule(
  subscriptionId: string,
  schedule: string | Stripe.SubscriptionSchedule | null,
) {
  const scheduleId = getScheduleId(schedule)

  if (scheduleId) {
    try {
      const existingSchedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
      if (existingSchedule.status === "active" || existingSchedule.status === "not_started") {
        return existingSchedule
      }
    } catch (error) {
      const missingSchedule =
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.code === "resource_missing"
      if (!missingSchedule) {
        throw error
      }
    }
  }

  return stripe.subscriptionSchedules.create({
    from_subscription: subscriptionId,
  })
}

export async function POST(req: NextRequest) {
  const _guard = communityGuard(); if (_guard) return _guard;
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const rl = rateLimitByUser(session.user.id, "checkout", 10)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { planId } = await req.json()

  const plan = await prisma.plan.findUnique({ where: { id: planId } })
  if (!plan || !plan.stripePriceId || !plan.isActive) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      stripeCustomerId: true,
      email: true,
      subscriptions: {
        where: { status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  })

  let customerId = user?.stripeCustomerId

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user?.email ?? session.user.email ?? undefined,
      metadata: { userId: session.user.id },
    })
    customerId = customer.id
    await prisma.user.update({
      where: { id: session.user.id },
      data: { stripeCustomerId: customerId },
    })
  }

  // If user has an active subscription, update it (upgrade/downgrade) instead of creating a new checkout
  const activeSub = user?.subscriptions[0]
  if (activeSub) {
    const stripeSub = await stripe.subscriptions.retrieve(activeSub.stripeSubscriptionId)
    const itemId = stripeSub.items.data[0]?.id
    const currentPlan = await prisma.plan.findUnique({
      where: { id: activeSub.planId },
      select: { id: true, priceMonthly: true },
    })

    if (itemId) {
      const isDowngrade = currentPlan ? plan.priceMonthly < currentPlan.priceMonthly : false

      if (isDowngrade) {
        const currentItem = stripeSub.items.data[0]
        const currentPriceId = currentItem?.price?.id
        const currentPeriodStart = currentItem?.current_period_start
        const currentPeriodEnd = currentItem?.current_period_end
        const quantity = currentItem?.quantity ?? 1

        if (!currentPriceId || !currentPeriodStart || !currentPeriodEnd) {
          return NextResponse.json(
            { error: "Unable to schedule downgrade for this subscription." },
            { status: 500 },
          )
        }

        const schedule = await getOrCreateActiveSchedule(
          activeSub.stripeSubscriptionId,
          stripeSub.schedule,
        )

        await stripe.subscriptionSchedules.update(schedule.id, {
          end_behavior: "release",
          phases: [
            {
              start_date: currentPeriodStart,
              end_date: currentPeriodEnd,
              items: [{ price: currentPriceId, quantity }],
              proration_behavior: "none",
            },
            {
              start_date: currentPeriodEnd,
              items: [{ price: plan.stripePriceId, quantity }],
              proration_behavior: "none",
              metadata: { userId: session.user.id, planId: plan.id, tier: plan.slug },
            },
          ],
        })

        return NextResponse.json({
          success: true,
          downgradedDeferred: true,
          effectiveAt: new Date(currentPeriodEnd * 1000).toISOString(),
        })
      }

      await releaseScheduleIfActive(stripeSub.schedule)

      let updatedStripeSub
      try {
        updatedStripeSub = await stripe.subscriptions.update(activeSub.stripeSubscriptionId, {
          items: [{ id: itemId, price: plan.stripePriceId }],
          // Invoice proration immediately and fail update when payment cannot be collected.
          proration_behavior: "always_invoice",
          payment_behavior: "error_if_incomplete",
          metadata: { userId: session.user.id, planId: plan.id, tier: plan.slug },
        })
      } catch (error) {
        if (error instanceof Stripe.errors.StripeError) {
          return NextResponse.json(
            {
              error:
                error.message ||
                "Unable to collect payment for this plan change. Please update your payment method.",
            },
            { status: 402 },
          )
        }
        throw error
      }

      const updatedCustomerId =
        typeof updatedStripeSub.customer === "string"
          ? updatedStripeSub.customer
          : updatedStripeSub.customer?.id ?? customerId
      const period = getPeriodDates(updatedStripeSub)

      if (updatedCustomerId) {
        await prisma.subscription.upsert({
          where: { stripeSubscriptionId: activeSub.stripeSubscriptionId },
          create: {
            userId: session.user.id,
            planId: plan.id,
            stripeSubscriptionId: activeSub.stripeSubscriptionId,
            stripeCustomerId: updatedCustomerId,
            status: updatedStripeSub.status,
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            cancelAtPeriodEnd: updatedStripeSub.cancel_at_period_end,
            canceledAt: updatedStripeSub.canceled_at
              ? new Date(updatedStripeSub.canceled_at * 1000)
              : null,
          },
          update: {
            planId: plan.id,
            stripeCustomerId: updatedCustomerId,
            status: updatedStripeSub.status,
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            cancelAtPeriodEnd: updatedStripeSub.cancel_at_period_end,
            canceledAt: updatedStripeSub.canceled_at
              ? new Date(updatedStripeSub.canceled_at * 1000)
              : null,
          },
        })

        await prisma.subscription.updateMany({
          where: {
            userId: session.user.id,
            status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] },
            NOT: { stripeSubscriptionId: activeSub.stripeSubscriptionId },
          },
          data: {
            status: "canceled",
            cancelAtPeriodEnd: false,
            canceledAt: new Date(),
          },
        })
      }

      return NextResponse.json({ success: true, upgraded: true })
    }
  }

  // New subscription — create checkout session
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: absoluteUrl(
      "/api/auth/subscribe-callback?session_id={CHECKOUT_SESSION_ID}&next=%2Fbilling"
    ),
    cancel_url: absoluteUrl("/billing?canceled=true"),
    metadata: { userId: session.user.id, planId: plan.id, tier: plan.slug },
  })

  return NextResponse.json({ url: checkoutSession.url })
}
