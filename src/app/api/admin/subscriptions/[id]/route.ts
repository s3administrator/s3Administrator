import { NextRequest, NextResponse } from "next/server"
import { communityGuard } from "@/lib/api-guard";
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { enforceThumbnailCachePolicyForUser } from "@/lib/thumbnail-cache-policy"
import { enforceObjectTransferPolicyForUser } from "@/lib/transfer-task-policy"
import Stripe from "stripe"
import { z } from "zod/v4"

const updateSubscriptionSchema = z.object({
  planId: z.string().min(1).max(128).optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
})

function getPeriodDates(sub: Stripe.Subscription) {
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
  const _guard = communityGuard(); if (_guard) return _guard;
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { id } = await params
  const body = await req.json()
  const parsed = updateSubscriptionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 })
  }

  if (parsed.data.planId === undefined && parsed.data.cancelAtPeriodEnd === undefined) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 })
  }

  const subscription = await prisma.subscription.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true } },
      plan: { select: { id: true, name: true, slug: true } },
    },
  })
  if (!subscription) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 })
  }

  if (subscription.status === "canceled") {
    return NextResponse.json({ error: "Cannot edit a canceled subscription" }, { status: 400 })
  }

  let targetPlanId = subscription.planId
  const stripeData: Stripe.SubscriptionUpdateParams = {}

  if (parsed.data.planId && parsed.data.planId !== subscription.planId) {
    const targetPlan = await prisma.plan.findUnique({
      where: { id: parsed.data.planId },
      select: { id: true, slug: true, stripePriceId: true, isActive: true },
    })
    if (!targetPlan || !targetPlan.isActive) {
      return NextResponse.json({ error: "Plan not found or inactive" }, { status: 400 })
    }
    if (!targetPlan.stripePriceId) {
      return NextResponse.json(
        { error: `Plan '${targetPlan.slug}' cannot be assigned because it has no Stripe price` },
        { status: 400 }
      )
    }

    const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId)
    const itemId = stripeSub.items.data[0]?.id
    if (!itemId) {
      return NextResponse.json(
        { error: "Active Stripe subscription item not found" },
        { status: 500 }
      )
    }

    stripeData.items = [{ id: itemId, price: targetPlan.stripePriceId }]
    stripeData.proration_behavior = "create_prorations"
    stripeData.metadata = {
      userId: subscription.userId,
      planId: targetPlan.id,
      tier: targetPlan.slug,
    }
    targetPlanId = targetPlan.id
  }

  if (
    parsed.data.cancelAtPeriodEnd !== undefined &&
    parsed.data.cancelAtPeriodEnd !== subscription.cancelAtPeriodEnd
  ) {
    stripeData.cancel_at_period_end = parsed.data.cancelAtPeriodEnd
  }

  const hasStripeUpdates = Object.keys(stripeData).length > 0

  let updated = subscription
  if (hasStripeUpdates) {
    const updatedStripeSub = await stripe.subscriptions.update(subscription.stripeSubscriptionId, stripeData)
    const period = getPeriodDates(updatedStripeSub)

    updated = await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: targetPlanId,
        status: updatedStripeSub.status,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        cancelAtPeriodEnd: updatedStripeSub.cancel_at_period_end,
        canceledAt: updatedStripeSub.canceled_at
          ? new Date(updatedStripeSub.canceled_at * 1000)
          : null,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        plan: { select: { id: true, name: true, slug: true } },
      },
    })
  }

  await Promise.all([
    enforceThumbnailCachePolicyForUser(subscription.userId),
    enforceObjectTransferPolicyForUser(subscription.userId),
  ])

  return NextResponse.json({ subscription: updated })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const _guard = communityGuard(); if (_guard) return _guard;
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { id } = await params

  const subscription = await prisma.subscription.findUnique({
    where: { id },
    select: { id: true, userId: true, stripeSubscriptionId: true, status: true },
  })
  if (!subscription) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 })
  }

  // Pure cleanup path for stale/canceled rows should not depend on Stripe state.
  if (subscription.status !== "canceled") {
    try {
      await stripe.subscriptions.cancel(subscription.stripeSubscriptionId)
    } catch (error) {
      const missingStripeSubscription =
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.code === "resource_missing"
      const alreadyCanceledStripeSubscription =
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.code === "subscription_already_canceled"
      if (!missingStripeSubscription && !alreadyCanceledStripeSubscription) {
        throw error
      }
    }
  }

  await prisma.subscription.delete({ where: { id: subscription.id } })

  await Promise.all([
    enforceThumbnailCachePolicyForUser(subscription.userId),
    enforceObjectTransferPolicyForUser(subscription.userId),
  ])

  return NextResponse.json({ success: true })
}
