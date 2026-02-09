import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { z } from "zod/v4"

const updateUserSchema = z.object({
  tier: z.enum(["free", "starter", "pro", "enterprise"]).optional(),
  role: z.enum(["user", "admin"]).optional(),
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
  const parsed = updateUserSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 })
  }

  const updated = await prisma.user.update({
    where: { id },
    data: parsed.data,
    select: { id: true, tier: true, role: true },
  })

  return NextResponse.json(updated)
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
    select: { stripeCustomerId: true, subscriptions: { where: { status: { in: ["active", "trialing", "past_due"] } } } },
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
