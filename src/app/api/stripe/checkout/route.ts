import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

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
        where: { status: { in: ["active", "trialing", "past_due"] } },
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

    if (itemId) {
      await stripe.subscriptions.update(activeSub.stripeSubscriptionId, {
        items: [{ id: itemId, price: plan.stripePriceId }],
        proration_behavior: "create_prorations",
        metadata: { userId: session.user.id, planId: plan.id, tier: plan.slug },
      })

      // The webhook will handle updating the local DB
      return NextResponse.json({ success: true, upgraded: true })
    }
  }

  // New subscription — create checkout session
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: `${process.env.AUTH_URL}/billing?success=true`,
    cancel_url: `${process.env.AUTH_URL}/billing?canceled=true`,
    metadata: { userId: session.user.id, planId: plan.id, tier: plan.slug },
  })

  return NextResponse.json({ url: checkoutSession.url })
}
