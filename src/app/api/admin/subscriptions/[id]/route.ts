import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

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

  const subscription = await prisma.subscription.findUnique({ where: { id } })
  if (!subscription) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 })
  }

  if (subscription.status === "canceled") {
    return NextResponse.json({ error: "Subscription is already canceled" }, { status: 400 })
  }

  // Cancel at period end so the user keeps perks until the billing cycle ends
  await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    cancel_at_period_end: true,
  })

  await prisma.subscription.update({
    where: { id },
    data: {
      cancelAtPeriodEnd: true,
      canceledAt: new Date(),
    },
  })

  return NextResponse.json({ success: true })
}
