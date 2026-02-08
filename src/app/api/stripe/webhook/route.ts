import { NextRequest, NextResponse } from "next/server"
import { stripe } from "@/lib/stripe"
import { prisma } from "@/lib/db"
import Stripe from "stripe"

export async function POST(req: NextRequest) {
  const body = await req.text()
  const signature = req.headers.get("stripe-signature")

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.userId
      const tier = session.metadata?.tier
      if (userId && tier) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            tier,
            stripeSubscriptionId: session.subscription as string,
          },
        })
      }
      break
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription
      const customerId = subscription.customer as string
      const user = await prisma.user.findUnique({
        where: { stripeCustomerId: customerId },
      })
      if (user) {
        const priceId = subscription.items.data[0]?.price?.id
        let tier = "free"
        if (priceId === process.env.STRIPE_PRO_PRICE_ID) tier = "pro"
        else if (priceId === process.env.STRIPE_TEAM_PRICE_ID) tier = "team"

        await prisma.user.update({
          where: { id: user.id },
          data: { tier },
        })
      }
      break
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription
      const customerId = subscription.customer as string
      await prisma.user.updateMany({
        where: { stripeCustomerId: customerId },
        data: { tier: "free", stripeSubscriptionId: null },
      })
      break
    }
  }

  return NextResponse.json({ received: true })
}
