import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"

export async function POST(req: NextRequest) {
  try {
    const { planId } = await req.json()

    const plan = await prisma.plan.findUnique({ where: { id: planId } })
    if (!plan || !plan.stripePriceId || !plan.isActive) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 })
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: `${process.env.AUTH_URL}/api/auth/subscribe-callback?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.AUTH_URL}/pricing?canceled=true`,
      metadata: { planId: plan.id, tier: plan.slug, guest: "true" },
    })

    return NextResponse.json({ url: checkoutSession.url })
  } catch (err) {
    console.error("Guest checkout error:", err)
    const message = err instanceof Error ? err.message : "Checkout failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
