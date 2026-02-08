export const TIER_LIMITS = {
  free: { buckets: 1, files: 1_000 },
  pro: { buckets: 10, files: 5_000 },
  team: { buckets: Infinity, files: 100_000 },
} as const

export type TierName = keyof typeof TIER_LIMITS

export function getTierLimits(tier: string) {
  return TIER_LIMITS[tier as TierName] ?? TIER_LIMITS.free
}
