export type PlanEntitlements = {
  slug: string
  source: "desktop"
  bucketLimit: number
  fileLimit: number
  storageLimitBytes: number
  thumbnailCache: boolean
  auditLogs: boolean
}

const UNLIMITED: PlanEntitlements = {
  slug: "desktop",
  source: "desktop",
  bucketLimit: Number.POSITIVE_INFINITY,
  fileLimit: Number.POSITIVE_INFINITY,
  storageLimitBytes: Number.POSITIVE_INFINITY,
  thumbnailCache: true,
  auditLogs: false,
}

export async function getUserPlanEntitlements(_userId: string): Promise<PlanEntitlements> {
  return UNLIMITED
}
