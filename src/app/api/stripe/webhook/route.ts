import { NextRequest, NextResponse } from "next/server"
import { communityGuard } from "@/lib/api-guard";
import { stripe } from "@/lib/stripe"
import { prisma } from "@/lib/db"
import { enforceThumbnailCachePolicyForUser } from "@/lib/thumbnail-cache-policy"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"
import Stripe from "stripe"

async function deactivateOtherActiveSubscriptions(userId: string, keepStripeSubscriptionId: string) {
  await prisma.subscription.updateMany({
    where: {
      userId,
      status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] },
      NOT: { stripeSubscriptionId: keepStripeSubscriptionId },
    },
    data: {
      status: "canceled",
      cancelAtPeriodEnd: false,
      canceledAt: new Date(),
    },
  })
}

export async function POST(req: NextRequest) {
  const _guard = communityGuard(); if (_guard) return _guard;
  const body = await req.text()
  const signature = req.headers.get("stripe-signature")

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  // In Stripe v20+, current_period_start/end are on subscription items, not the subscription itself
  function getPeriodDates(sub: Stripe.Subscription) {
    const item = sub.items.data[0]
    return {
      start: new Date((item?.current_period_start ?? 0) * 1000),
      end: new Date((item?.current_period_end ?? 0) * 1000),
    }
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.userId
      const planId = session.metadata?.planId
      const stripeSubId = session.subscription as string
      if (!stripeSubId) break

      const stripeSub = await stripe.subscriptions.retrieve(stripeSubId)
      const stripePriceId = stripeSub.items.data[0]?.price?.id

      const resolvedPlan =
        (planId ? await prisma.plan.findUnique({ where: { id: planId } }) : null) ??
        (stripePriceId
          ? await prisma.plan.findUnique({ where: { stripePriceId } })
          : null)

      if (userId) {
        // Authenticated checkout — user already exists
        await prisma.user.update({
          where: { id: userId },
          data: { stripeCustomerId: stripeSub.customer as string },
        })

        if (resolvedPlan) {
          const period = getPeriodDates(stripeSub)
          await prisma.subscription.upsert({
            where: { stripeSubscriptionId: stripeSubId },
            create: {
              userId,
              planId: resolvedPlan.id,
              stripeSubscriptionId: stripeSubId,
              stripeCustomerId: stripeSub.customer as string,
              status: stripeSub.status,
              currentPeriodStart: period.start,
              currentPeriodEnd: period.end,
            },
            update: {
              planId: resolvedPlan.id,
              stripeCustomerId: stripeSub.customer as string,
              status: stripeSub.status,
              currentPeriodStart: period.start,
              currentPeriodEnd: period.end,
            },
          })

          await deactivateOtherActiveSubscriptions(userId, stripeSubId)
        }

        await enforceThumbnailCachePolicyForUser(userId)
      } else if (session.metadata?.guest === "true" && resolvedPlan) {
        // Guest checkout — find or create user from Stripe email
        const customerEmail = session.customer_details?.email
        const stripeCustomerId = session.customer as string

        if (!customerEmail) {
          console.error("Guest checkout webhook: no email in session")
          break
        }

        const period = getPeriodDates(stripeSub)

        let user = await prisma.user.findUnique({
          where: { email: customerEmail },
        })

        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { stripeCustomerId },
          })
        } else {
          try {
            user = await prisma.user.create({
              data: {
                email: customerEmail,
                emailVerified: new Date(),
                stripeCustomerId,
              },
            })
          } catch (e: unknown) {
            // Race condition: callback route may have created user first
            if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
              user = await prisma.user.findUnique({ where: { email: customerEmail } })
              if (user) {
                await prisma.user.update({
                  where: { id: user.id },
                  data: { stripeCustomerId },
                })
              }
            } else {
              throw e
            }
          }
        }

        if (user) {
          await prisma.subscription.upsert({
            where: { stripeSubscriptionId: stripeSubId },
            create: {
              userId: user.id,
              planId: resolvedPlan.id,
              stripeSubscriptionId: stripeSubId,
              stripeCustomerId,
              status: stripeSub.status,
              currentPeriodStart: period.start,
              currentPeriodEnd: period.end,
            },
            update: {
              planId: resolvedPlan.id,
              stripeCustomerId,
              status: stripeSub.status,
              currentPeriodStart: period.start,
              currentPeriodEnd: period.end,
            },
          })

          await deactivateOtherActiveSubscriptions(user.id, stripeSubId)
          await enforceThumbnailCachePolicyForUser(user.id)
        }
      }
      break
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription
      const customerId = subscription.customer as string
      const priceId = subscription.items.data[0]?.price?.id

      const user = await prisma.user.findUnique({
        where: { stripeCustomerId: customerId },
      })

      if (user && priceId) {
        // Look up the plan by stripePriceId
        const plan = await prisma.plan.findUnique({
          where: { stripePriceId: priceId },
        })

        // Update or create subscription record
        const period = getPeriodDates(subscription)
        const subData = {
          status: subscription.status,
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          canceledAt: subscription.canceled_at
            ? new Date(subscription.canceled_at * 1000)
            : null,
        }

        if (plan) {
          await prisma.subscription.upsert({
            where: { stripeSubscriptionId: subscription.id },
            create: {
              userId: user.id,
              planId: plan.id,
              stripeSubscriptionId: subscription.id,
              stripeCustomerId: customerId,
              ...subData,
            },
            update: {
              planId: plan.id,
              ...subData,
            },
          })

          await deactivateOtherActiveSubscriptions(user.id, subscription.id)
        } else {
          // Plan not found in DB — just update if exists
          await prisma.subscription.updateMany({
            where: { stripeSubscriptionId: subscription.id },
            data: subData,
          })
        }

        await enforceThumbnailCachePolicyForUser(user.id)
      }
      break
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription
      const affectedSubscriptions = await prisma.subscription.findMany({
        where: { stripeSubscriptionId: subscription.id },
        select: { userId: true },
      })

      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: subscription.id },
        data: {
          status: "canceled",
          cancelAtPeriodEnd: false,
          canceledAt: new Date(),
        },
      })

      const affectedUserIds = [...new Set(affectedSubscriptions.map((sub) => sub.userId))]
      for (const userId of affectedUserIds) {
        await enforceThumbnailCachePolicyForUser(userId)
      }
      break
    }
  }

  return NextResponse.json({ received: true })
}
