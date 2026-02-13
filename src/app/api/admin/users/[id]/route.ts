import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { enforceThumbnailCachePolicyForUser } from "@/lib/thumbnail-cache-policy"
import { enforceObjectTransferPolicyForUser } from "@/lib/transfer-task-policy"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"
import { z } from "zod/v4"

const updateUserSchema = z.object({
  tier: z.string().trim().min(1).max(64).optional(),
  role: z.enum(["user", "admin"]).optional(),
})

function getPeriodDates(sub: Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>) {
  const item = sub.items.data[0]
  return {
    start: new Date((item?.current_period_start ?? 0) * 1000),
    end: new Date((item?.current_period_end ?? 0) * 1000),
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { id } = await params
  const body = await req.json()
  const parsed = updateUserSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      role: true,
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
          planId: true,
          plan: {
            select: {
              id: true,
              slug: true,
              stripePriceId: true,
            },
          },
        },
      },
    },
  })

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 })
  }

  if (parsed.data.tier !== undefined) {
    let keepSubscriptionId: string | null = null
    const targetPlan = await prisma.plan.findUnique({
      where: { slug: parsed.data.tier },
      select: { id: true, slug: true, stripePriceId: true, isActive: true },
    })
    if (!targetPlan || !targetPlan.isActive) {
      return NextResponse.json({ error: "Plan not found or inactive" }, { status: 400 })
    }

    const activeSubscription = user.subscriptions[0]

    if (targetPlan.slug === "free") {
      if (activeSubscription?.stripeSubscriptionId) {
        await stripe.subscriptions.cancel(activeSubscription.stripeSubscriptionId)
      }

      if (activeSubscription) {
        await prisma.subscription.update({
          where: { id: activeSubscription.id },
          data: {
            status: "canceled",
            cancelAtPeriodEnd: false,
            canceledAt: new Date(),
          },
        })
      }
    } else {
      if (!targetPlan.stripePriceId) {
        return NextResponse.json(
          { error: `Plan '${targetPlan.slug}' cannot be assigned because it has no Stripe price` },
          { status: 400 }
        )
      }

      let customerId = user.stripeCustomerId
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { userId: user.id },
        })
        customerId = customer.id
        await prisma.user.update({
          where: { id: user.id },
          data: { stripeCustomerId: customerId },
        })
      }

      if (activeSubscription?.stripeSubscriptionId) {
        const stripeSub = await stripe.subscriptions.retrieve(activeSubscription.stripeSubscriptionId)
        const itemId = stripeSub.items.data[0]?.id
        if (!itemId) {
          return NextResponse.json(
            { error: "Active Stripe subscription item not found" },
            { status: 500 }
          )
        }

        const updatedStripeSub = await stripe.subscriptions.update(activeSubscription.stripeSubscriptionId, {
          items: [{ id: itemId, price: targetPlan.stripePriceId }],
          proration_behavior: "create_prorations",
          metadata: { userId: user.id, planId: targetPlan.id, tier: targetPlan.slug },
        })

        const period = getPeriodDates(updatedStripeSub)
        const updatedSubscription = await prisma.subscription.update({
          where: { id: activeSubscription.id },
          data: {
            planId: targetPlan.id,
            status: updatedStripeSub.status,
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            cancelAtPeriodEnd: updatedStripeSub.cancel_at_period_end,
            canceledAt: updatedStripeSub.canceled_at
              ? new Date(updatedStripeSub.canceled_at * 1000)
              : null,
          },
        })
        keepSubscriptionId = updatedSubscription.id
      } else {
        const createdStripeSub = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: targetPlan.stripePriceId }],
          metadata: { userId: user.id, planId: targetPlan.id, tier: targetPlan.slug },
        })

        const period = getPeriodDates(createdStripeSub)
        const syncedSubscription = await prisma.subscription.upsert({
          where: { stripeSubscriptionId: createdStripeSub.id },
          create: {
            userId: user.id,
            planId: targetPlan.id,
            stripeSubscriptionId: createdStripeSub.id,
            stripeCustomerId: customerId,
            status: createdStripeSub.status,
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            cancelAtPeriodEnd: createdStripeSub.cancel_at_period_end,
            canceledAt: createdStripeSub.canceled_at
              ? new Date(createdStripeSub.canceled_at * 1000)
              : null,
          },
          update: {
            planId: targetPlan.id,
            stripeCustomerId: customerId,
            status: createdStripeSub.status,
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
            cancelAtPeriodEnd: createdStripeSub.cancel_at_period_end,
            canceledAt: createdStripeSub.canceled_at
              ? new Date(createdStripeSub.canceled_at * 1000)
              : null,
          },
        })
        keepSubscriptionId = syncedSubscription.id
      }
    }

    await prisma.subscription.updateMany({
      where: {
        userId: user.id,
        status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] },
        ...(keepSubscriptionId
          ? {
              NOT: {
                id: keepSubscriptionId,
              },
            }
          : {}),
      },
      data: {
        status: "canceled",
        cancelAtPeriodEnd: false,
        canceledAt: new Date(),
      },
    })

    await enforceThumbnailCachePolicyForUser(user.id)
    await enforceObjectTransferPolicyForUser(user.id)
  }

  if (parsed.data.role !== undefined) {
    await prisma.user.update({
      where: { id },
      data: { role: parsed.data.role },
    })
  }

  const refreshed = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      role: true,
      subscriptions: {
        where: { status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] } },
        orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: {
          plan: { select: { slug: true } },
        },
      },
    },
  })

  return NextResponse.json({
    id,
    role: refreshed?.role ?? parsed.data.role ?? user.role,
    tier: refreshed?.subscriptions[0]?.plan.slug ?? "free",
  })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { id } = await params

  if (id === session.user.id) {
    return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      stripeCustomerId: true,
      subscriptions: { where: { status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] } } },
    },
  })

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 })
  }

  // Cancel active Stripe subscriptions
  for (const sub of user.subscriptions) {
    try {
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId)
    } catch {
      // Subscription may already be canceled in Stripe
    }
  }

  // Cascade delete handles all related records
  await prisma.user.delete({ where: { id } })

  return NextResponse.json({ success: true })
}
