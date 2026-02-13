import { prisma } from "@/lib/db"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"
import { TIER_LIMITS } from "@/lib/tiers"

type PlanSnapshot = {
  slug: string
  bucketLimit: number
  fileLimit: number
  thumbnailCache: boolean
  transferTasks: boolean
}

export type PlanSource = "subscription" | "default"

export interface PlanEntitlements {
  slug: string
  source: PlanSource
  bucketLimit: number
  fileLimit: number
  thumbnailCache: boolean
  transferTasks: boolean
}

function normalizeLimit(limit: number): number {
  return limit <= 0 ? Number.POSITIVE_INFINITY : limit
}

function buildEntitlements(plan: PlanSnapshot, source: PlanSource): PlanEntitlements {
  return {
    slug: plan.slug,
    source,
    bucketLimit: normalizeLimit(plan.bucketLimit),
    fileLimit: normalizeLimit(plan.fileLimit),
    thumbnailCache: plan.thumbnailCache,
    transferTasks: plan.transferTasks,
  }
}

async function findPlanBySlug(slug: string): Promise<PlanSnapshot | null> {
  const trimmed = slug.trim()
  if (!trimmed) return null

  const select = {
    slug: true,
    bucketLimit: true,
    fileLimit: true,
    thumbnailCache: true,
    transferTasks: true,
  } as const

  const exact = await prisma.plan.findUnique({
    where: { slug: trimmed },
    select,
  })
  if (exact) return exact

  return prisma.plan.findFirst({
    where: {
      slug: {
        equals: trimmed,
        mode: "insensitive",
      },
    },
    select,
  })
}

export async function getUserPlanEntitlements(userId: string): Promise<PlanEntitlements | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      subscriptions: {
        where: {
          status: {
            in: [...ACTIVE_SUBSCRIPTION_STATUSES],
          },
        },
        orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: {
          plan: {
            select: {
              slug: true,
              bucketLimit: true,
              fileLimit: true,
              thumbnailCache: true,
              transferTasks: true,
            },
          },
        },
      },
    },
  })

  if (!user) {
    return null
  }

  const activePlan = user.subscriptions[0]?.plan
  if (activePlan) {
    return buildEntitlements(activePlan, "subscription")
  }

  const freePlan = await findPlanBySlug("free")
  if (freePlan) {
    return buildEntitlements(freePlan, "default")
  }

  return {
    slug: "free",
    source: "default",
    bucketLimit: TIER_LIMITS.free.buckets,
    fileLimit: TIER_LIMITS.free.files,
    thumbnailCache: false,
    transferTasks: false,
  }
}
