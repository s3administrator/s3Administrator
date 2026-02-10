import { purgeMediaThumbnailsForUser } from "@/lib/media-thumbnails"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"

export async function isThumbnailCacheEnabledForUser(userId: string): Promise<boolean> {
  const entitlements = await getUserPlanEntitlements(userId)
  return entitlements?.thumbnailCache ?? false
}

export async function enforceThumbnailCachePolicyForUser(userId: string) {
  const enabled = await isThumbnailCacheEnabledForUser(userId)
  if (enabled) {
    return {
      enabled: true,
      purged: false,
      deletedRows: 0,
      deletedObjects: 0,
      deletedTasks: 0,
    }
  }

  const purged = await purgeMediaThumbnailsForUser({ userId })

  return {
    enabled: false,
    purged: true,
    ...purged,
  }
}
