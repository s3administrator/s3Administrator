export async function isObjectTransferEnabledForUser(_userId: string): Promise<boolean> {
  return true
}

export async function enforceObjectTransferPolicyForUser(_userId: string) {
  return {
    enabled: true,
    disabledTasks: 0,
  }
}

export function getObjectTransferDisabledMessage() {
  return "Object transfer is disabled for the current plan"
}
