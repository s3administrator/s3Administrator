import { prisma } from "@/lib/db"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"

const DISABLED_MESSAGE = "Object transfer is disabled for the current plan"

export async function isObjectTransferEnabledForUser(userId: string): Promise<boolean> {
  const entitlements = await getUserPlanEntitlements(userId)
  return entitlements?.transferTasks ?? false
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
