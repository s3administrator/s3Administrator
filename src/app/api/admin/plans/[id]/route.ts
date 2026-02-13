import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { enforceThumbnailCachePolicyForUser } from "@/lib/thumbnail-cache-policy"
import { enforceObjectTransferPolicyForUser } from "@/lib/transfer-task-policy"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"
import { z } from "zod/v4"

const updatePlanSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  priceMonthly: z.number().int().min(0).optional(),
  bucketLimit: z.number().int().min(0).optional(),
  fileLimit: z.number().int().min(0).optional(),
  features: z.array(z.string()).optional(),
  thumbnailCache: z.boolean().optional(),
  transferTasks: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

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
  const parsed = updatePlanSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 })
  }

  const plan = await prisma.plan.findUnique({ where: { id } })
  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 })
  }

  const data: Record<string, unknown> = { ...parsed.data }

  // If price changed, create a new Stripe price and archive the old one
  if (parsed.data.priceMonthly !== undefined && parsed.data.priceMonthly !== plan.priceMonthly) {
    const newPrice = parsed.data.priceMonthly

    if (newPrice > 0) {
      // Find existing product or create new one
      let productId: string
      if (plan.stripePriceId) {
        const existingPrice = await stripe.prices.retrieve(plan.stripePriceId)
        productId = existingPrice.product as string
        // Archive old price
        await stripe.prices.update(plan.stripePriceId, { active: false })
      } else {
        const product = await stripe.products.create({
          name: parsed.data.name ?? plan.name,
          metadata: { slug: plan.slug },
        })
        productId = product.id
      }

      const price = await stripe.prices.create({
        product: productId,
        unit_amount: newPrice,
        currency: "usd",
        recurring: { interval: "month" },
        metadata: { slug: plan.slug },
      })

      data.stripePriceId = price.id
    } else {
      // Price set to 0 (free): archive old Stripe price
      if (plan.stripePriceId) {
        await stripe.prices.update(plan.stripePriceId, { active: false })
      }
      data.stripePriceId = null
    }
  }

  const updated = await prisma.plan.update({
    where: { id },
    data,
  })

  const thumbnailPolicyChanged =
    parsed.data.thumbnailCache !== undefined &&
    parsed.data.thumbnailCache !== plan.thumbnailCache
  const transferPolicyChanged =
    parsed.data.transferTasks !== undefined &&
    parsed.data.transferTasks !== plan.transferTasks

  if (thumbnailPolicyChanged || transferPolicyChanged) {
    const [freeUsers, subscriptionUsers] = await Promise.all([
      updated.slug === "free"
        ? prisma.user.findMany({
            where: {
              subscriptions: {
                none: {
                  status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] },
                },
              },
            },
            select: { id: true },
          })
        : Promise.resolve([] as Array<{ id: string }>),
      prisma.subscription.findMany({
        where: {
          planId: updated.id,
          status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] },
        },
        select: { userId: true },
      }),
    ])

    const affectedUserIds = new Set<string>()
    for (const user of freeUsers) {
      affectedUserIds.add(user.id)
    }
    for (const subscription of subscriptionUsers) {
      affectedUserIds.add(subscription.userId)
    }

    for (const userId of affectedUserIds) {
      if (thumbnailPolicyChanged) {
        await enforceThumbnailCachePolicyForUser(userId)
      }
      if (transferPolicyChanged) {
        await enforceObjectTransferPolicyForUser(userId)
      }
    }
  }

  return NextResponse.json({ plan: updated })
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

  const activeSubscriptions = await prisma.subscription.count({
    where: { planId: id, status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] } },
  })

  if (activeSubscriptions > 0) {
    return NextResponse.json(
      { error: `Cannot delete plan with ${activeSubscriptions} active subscription(s). Deactivate it instead.` },
      { status: 409 }
    )
  }

  // Archive Stripe price if exists
  const plan = await prisma.plan.findUnique({ where: { id } })
  if (plan?.stripePriceId) {
    await stripe.prices.update(plan.stripePriceId, { active: false })
  }

  await prisma.plan.delete({ where: { id } })

  return NextResponse.json({ success: true })
}
