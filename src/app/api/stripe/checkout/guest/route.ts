import { NextRequest, NextResponse } from "next/server"
import { communityGuard } from "@/lib/api-guard";
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { rateLimitByIp, rateLimitResponse } from "@/lib/rate-limit"
import { absoluteUrl } from "@/lib/site-url"

export async function POST(req: NextRequest) {
  const _guard = communityGuard(); if (_guard) return _guard;
  const rl = rateLimitByIp(req, "guest-checkout", 3)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  try {
    const { planId } = await req.json()

    const plan = await prisma.plan.findUnique({ where: { id: planId } })
    if (!plan || !plan.stripePriceId || !plan.isActive) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 })
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: absoluteUrl("/api/auth/subscribe-callback?session_id={CHECKOUT_SESSION_ID}"),
      cancel_url: absoluteUrl("/pricing?canceled=true"),
      metadata: { planId: plan.id, tier: plan.slug, guest: "true" },
    })

    return NextResponse.json({ url: checkoutSession.url })
  } catch (err) {
    console.error("Guest checkout error:", err)
    return NextResponse.json({ error: "Checkout failed" }, { status: 500 })
  }
}
