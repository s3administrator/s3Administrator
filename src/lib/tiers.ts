export const TIER_LIMITS = {
  free: { buckets: 10, files: 10_000 },
  starter: { buckets: 50, files: 50_000 },
  pro: { buckets: 1_000, files: 500_000 },
  enterprise: { buckets: 1_000, files: Infinity },
} as const

export type TierName = keyof typeof TIER_LIMITS

export function getTierLimits(tier: string) {
  return TIER_LIMITS[tier as TierName] ?? TIER_LIMITS.free
}
