import Stripe from "stripe"
import { isCommunityEdition } from "@/lib/edition"
import { envVar } from "@/lib/env"

function getStripeClient() {
  if (isCommunityEdition()) {
    throw new Error("Stripe is not available in community edition")
  }

  const key = envVar("STRIPE_SECRET_KEY")
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

