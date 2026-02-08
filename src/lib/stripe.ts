import Stripe from "stripe"

function getStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured")
  }
  return new Stripe(key, {
    apiVersion: "2026-01-28.clover",
  })
}

let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = getStripeClient()
  }
  return _stripe
}

export const stripe = new Proxy({} as Stripe, {
  get(_, prop) {
    return (getStripe() as unknown as Record<string | symbol, unknown>)[prop]
  },
})

export function getPriceIdForTier(tier: string): string | null {
  switch (tier) {
    case "starter":
      return process.env.STRIPE_STARTER_PRICE_ID || null
    case "pro":
      return process.env.STRIPE_PRO_PRICE_ID || null
    default:
      return null
  }
}
