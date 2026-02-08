export const TIER_LIMITS = {
  free: { buckets: 1, files: 1_000 },
  starter: { buckets: 10, files: 10_000 },
  pro: { buckets: Infinity, files: 100_000 },
  enterprise: { buckets: Infinity, files: Infinity },
} as const

export type TierName = keyof typeof TIER_LIMITS

export function getTierLimits(tier: string) {
  return TIER_LIMITS[tier as TierName] ?? TIER_LIMITS.free
}
