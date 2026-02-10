import { prisma } from "@/lib/db"
import { TIER_LIMITS } from "@/lib/tiers"

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const

type PlanSnapshot = {
  slug: string
  bucketLimit: number
  fileLimit: number
  thumbnailCache: boolean
  transferTasks: boolean
}

export type PlanSource = "subscription" | "tier" | "default"

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

function mergeSubscriptionPlans(plans: PlanSnapshot[]): PlanEntitlements {
  const primary = plans[0]
  const bucketLimit = plans.reduce((max, plan) => Math.max(max, normalizeLimit(plan.bucketLimit)), 0)
  const fileLimit = plans.reduce((max, plan) => Math.max(max, normalizeLimit(plan.fileLimit)), 0)

  return {
    slug: primary.slug,
    source: "subscription",
    bucketLimit,
    fileLimit,
    thumbnailCache: plans.some((plan) => plan.thumbnailCache),
    transferTasks: plans.some((plan) => plan.transferTasks),
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
      tier: true,
      subscriptions: {
        where: {
          status: {
            in: [...ACTIVE_SUBSCRIPTION_STATUSES],
          },
        },
        orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
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

  const activePlans = user.subscriptions
    .map((subscription) => subscription.plan)
    .filter((plan): plan is PlanSnapshot => Boolean(plan))

  if (activePlans.length > 0) {
    return mergeSubscriptionPlans(activePlans)
  }

  const tierPlan = await findPlanBySlug(user.tier)
  if (tierPlan) {
    return buildEntitlements(tierPlan, "tier")
  }

  return {
    slug: user.tier || "free",
    source: "default",
    bucketLimit: TIER_LIMITS.free.buckets,
    fileLimit: TIER_LIMITS.free.files,
    thumbnailCache: false,
    transferTasks: false,
  }
}
