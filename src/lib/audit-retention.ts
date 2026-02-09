export type SupportedTier = "starter" | "pro" | "enterprise" | "free"

const RETENTION_DAYS_BY_TIER: Record<SupportedTier, number> = {
  free: 7,
  starter: 7,
  pro: 14,
  enterprise: 30,
}

export function getAuditRetentionDays(tier: string | null | undefined): number {
  if (!tier) return RETENTION_DAYS_BY_TIER.free
  const normalized = tier.toLowerCase() as SupportedTier
  return RETENTION_DAYS_BY_TIER[normalized] ?? RETENTION_DAYS_BY_TIER.free
}

export function getAuditCutoffDate(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
}

