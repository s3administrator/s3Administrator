// Desktop single-user build: plan/quota gating is intentionally absent.
// All limit-violation checks return null (no violation).

export async function getBucketLimitViolation(_args: unknown): Promise<null> {
  return null
}

export async function getAdditionalFileLimitViolation(_args: unknown): Promise<null> {
  return null
}

export async function getAdditionalStorageLimitViolation(_args: unknown): Promise<null> {
  return null
}
