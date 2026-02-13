import { prisma } from "@/lib/db"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"
import { TIER_LIMITS } from "@/lib/tiers"

type PlanSnapshot = {
  slug: string
  bucketLimit: number
  fileLimit: number
  thumbnailCache: boolean
  transferTasks: boolean
  recursiveDelete: boolean
  multipleUpload: boolean
  copyFolderToFolder: boolean
  copyBucketToBucket: boolean
  auditLogs: boolean
  searchAllFiles: boolean
  syncTasks: boolean
}

export type PlanSource = "subscription" | "default"

export interface PlanEntitlements {
  slug: string
  source: PlanSource
  bucketLimit: number
  fileLimit: number
  thumbnailCache: boolean
  transferTasks: boolean
  recursiveDelete: boolean
  multipleUpload: boolean
  copyFolderToFolder: boolean
  copyBucketToBucket: boolean
  auditLogs: boolean
  searchAllFiles: boolean
  syncTasks: boolean
}

const MAX_BUCKET_LIMIT = 1000

function normalizeFileLimit(limit: number): number {
  return limit <= 0 ? Number.POSITIVE_INFINITY : limit
}

function normalizeBucketLimit(limit: number): number {
  if (limit <= 0) return MAX_BUCKET_LIMIT
  return Math.min(MAX_BUCKET_LIMIT, limit)
}

function buildEntitlements(plan: PlanSnapshot, source: PlanSource): PlanEntitlements {
  const transferTasks =
    plan.transferTasks ||
    plan.copyFolderToFolder ||
    plan.copyBucketToBucket ||
    plan.syncTasks

  return {
    slug: plan.slug,
    source,
    bucketLimit: normalizeBucketLimit(plan.bucketLimit),
    fileLimit: normalizeFileLimit(plan.fileLimit),
    thumbnailCache: plan.thumbnailCache,
    transferTasks,
    recursiveDelete: plan.recursiveDelete,
    multipleUpload: plan.multipleUpload,
    copyFolderToFolder: plan.copyFolderToFolder,
    copyBucketToBucket: plan.copyBucketToBucket,
    auditLogs: plan.auditLogs,
    searchAllFiles: plan.searchAllFiles,
    syncTasks: plan.syncTasks,
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
    recursiveDelete: true,
    multipleUpload: true,
    copyFolderToFolder: true,
    copyBucketToBucket: true,
    auditLogs: true,
    searchAllFiles: true,
    syncTasks: true,
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
              recursiveDelete: true,
              multipleUpload: true,
              copyFolderToFolder: true,
              copyBucketToBucket: true,
              auditLogs: true,
              searchAllFiles: true,
              syncTasks: true,
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
    bucketLimit: normalizeBucketLimit(TIER_LIMITS.free.buckets),
    fileLimit: normalizeFileLimit(TIER_LIMITS.free.files),
    thumbnailCache: false,
    transferTasks: false,
    recursiveDelete: true,
    multipleUpload: true,
    copyFolderToFolder: false,
    copyBucketToBucket: false,
    auditLogs: false,
    searchAllFiles: false,
    syncTasks: false,
  }
}
