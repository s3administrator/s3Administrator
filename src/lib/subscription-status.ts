export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const

export type ActiveSubscriptionStatus = (typeof ACTIVE_SUBSCRIPTION_STATUSES)[number]
