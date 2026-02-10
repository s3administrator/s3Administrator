import { prisma } from "@/lib/db"

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"] as const
const DISABLED_MESSAGE = "Object transfer is disabled for the current subscription plan"

export async function isObjectTransferEnabledForUser(userId: string): Promise<boolean> {
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
        take: 1,
        select: {
          plan: {
            select: {
              transferTasks: true,
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
    return activePlan.transferTasks
  }

  const tierPlan = await prisma.plan.findUnique({
    where: { slug: user.tier },
    select: { transferTasks: true },
  })

  return tierPlan?.transferTasks ?? false
}

export async function enforceObjectTransferPolicyForUser(userId: string) {
  const enabled = await isObjectTransferEnabledForUser(userId)
  if (enabled) {
    return {
      enabled: true,
      disabledTasks: 0,
    }
  }

  const now = new Date()
  const disabled = await prisma.backgroundTask.updateMany({
    where: {
      userId,
      type: "object_transfer",
      status: { in: ["pending", "in_progress"] },
    },
    data: {
      status: "failed",
      completedAt: now,
      nextRunAt: now,
      lastError: DISABLED_MESSAGE,
    },
  })

  return {
    enabled: false,
    disabledTasks: disabled.count,
  }
}

export function getObjectTransferDisabledMessage() {
  return DISABLED_MESSAGE
}
