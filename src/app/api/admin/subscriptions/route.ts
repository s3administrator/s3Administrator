import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { enforceThumbnailCachePolicyForUser } from "@/lib/thumbnail-cache-policy"
import { enforceObjectTransferPolicyForUser } from "@/lib/transfer-task-policy"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"
import Stripe from "stripe"
import { z } from "zod/v4"

const createSubscriptionSchema = z.object({
  userEmail: z.string().email().max(320),
  planId: z.string().min(1).max(128),
})

function getPeriodDates(sub: Stripe.Subscription) {
  const item = sub.items.data[0]
  return {
    start: new Date((item?.current_period_start ?? 0) * 1000),
    end: new Date((item?.current_period_end ?? 0) * 1000),
  }
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { searchParams } = req.nextUrl
  const rawPage = parseInt(searchParams.get("page") ?? "1", 10)
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1
  const limit = 20
  const skip = (page - 1) * limit

  const [subscriptions, total] = await Promise.all([
    prisma.subscription.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, email: true } },
        plan: { select: { id: true, name: true, slug: true } },
      },
    }),
    prisma.subscription.count(),
  ])

  return NextResponse.json({ subscriptions, total, page, limit })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const body = await req.json()
  const parsed = createSubscriptionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 })
  }

  const email = parsed.data.userEmail.trim()
  const plan = await prisma.plan.findUnique({
    where: { id: parsed.data.planId },
    select: { id: true, slug: true, stripePriceId: true, isActive: true },
  })
  if (!plan || !plan.isActive) {
    return NextResponse.json({ error: "Plan not found or inactive" }, { status: 400 })
  }
  if (!plan.stripePriceId) {
    return NextResponse.json(
      { error: `Plan '${plan.slug}' cannot be assigned because it has no Stripe price` },
      { status: 400 }
    )
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: {
      id: true,
      email: true,
      stripeCustomerId: true,
      subscriptions: {
        where: { status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] } },
        orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: {
          id: true,
          stripeSubscriptionId: true,
        },
      },
    },
  })

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 })
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

  let mode: "created" | "updated" = "created"
  let keepSubscriptionId: string

  const activeSubscription = user.subscriptions[0]
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
      items: [{ id: itemId, price: plan.stripePriceId }],
      proration_behavior: "create_prorations",
      metadata: { userId: user.id, planId: plan.id, tier: plan.slug },
    })

    const period = getPeriodDates(updatedStripeSub)
    const updated = await prisma.subscription.update({
      where: { id: activeSubscription.id },
      data: {
        planId: plan.id,
        stripeCustomerId: customerId,
        status: updatedStripeSub.status,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        cancelAtPeriodEnd: updatedStripeSub.cancel_at_period_end,
        canceledAt: updatedStripeSub.canceled_at
          ? new Date(updatedStripeSub.canceled_at * 1000)
          : null,
      },
    })

    keepSubscriptionId = updated.id
    mode = "updated"
  } else {
    const createdStripeSub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: plan.stripePriceId }],
      metadata: { userId: user.id, planId: plan.id, tier: plan.slug },
    })

    const period = getPeriodDates(createdStripeSub)
    const syncedSubscription = await prisma.subscription.upsert({
      where: { stripeSubscriptionId: createdStripeSub.id },
      create: {
        userId: user.id,
        planId: plan.id,
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
        userId: user.id,
        planId: plan.id,
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

  await prisma.subscription.updateMany({
    where: {
      userId: user.id,
      status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] },
      NOT: { id: keepSubscriptionId },
    },
    data: {
      status: "canceled",
      cancelAtPeriodEnd: false,
      canceledAt: new Date(),
    },
  })

  await Promise.all([
    enforceThumbnailCachePolicyForUser(user.id),
    enforceObjectTransferPolicyForUser(user.id),
  ])

  const subscription = await prisma.subscription.findUnique({
    where: { id: keepSubscriptionId },
    include: {
      user: { select: { id: true, name: true, email: true } },
      plan: { select: { id: true, name: true, slug: true } },
    },
  })

  return NextResponse.json({ subscription, mode }, { status: mode === "created" ? 201 : 200 })
}
