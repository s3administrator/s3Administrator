import { prisma } from "@/lib/db"
import { purgeMediaThumbnailsForUser } from "@/lib/media-thumbnails"

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const

export async function isThumbnailCacheEnabledForUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      tier: true,
      subscriptions: {
        where: {
          status: {
            in: [...ACTIVE_SUBSCRIPTION_STATUSES],
          },
        },
        orderBy: [
          { currentPeriodEnd: "desc" },
          { createdAt: "desc" },
        ],
        take: 1,
        select: {
          plan: {
            select: {
              thumbnailCache: true,
            },
          },
        },
      },
    },
  })

  if (!user) {
    return false
  }

  const activePlan = user.subscriptions[0]?.plan
  if (activePlan) {
    return activePlan.thumbnailCache
  }

  const tierPlan = await prisma.plan.findUnique({
    where: { slug: user.tier },
    select: { thumbnailCache: true },
  })

  return tierPlan?.thumbnailCache ?? false
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
