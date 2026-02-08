import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe, getPriceIdForTier } from "@/lib/stripe"

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { tier } = await req.json()
  const priceId = getPriceIdForTier(tier)
  if (!priceId) {
    return NextResponse.json({ error: "Invalid tier" }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { stripeCustomerId: true, email: true },
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

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.AUTH_URL}/billing?success=true`,
    cancel_url: `${process.env.AUTH_URL}/billing?canceled=true`,
    metadata: { userId: session.user.id, tier },
  })

  return NextResponse.json({ url: checkoutSession.url })
}
