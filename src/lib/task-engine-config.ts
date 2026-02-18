import { isCommunityEdition } from "@/lib/edition"

export type TaskTypeName = "bulk_delete" | "object_transfer" | "thumbnail_generate"

const community = isCommunityEdition()

const TYPE_ENV_SUFFIX: Record<TaskTypeName, string> = {
  bulk_delete: "BULK_DELETE",
  object_transfer: "OBJECT_TRANSFER",
  thumbnail_generate: "THUMBNAIL_GENERATE",
}

const PER_TYPE_MAX_ACTIVE: Record<TaskTypeName, number> = {
  bulk_delete: community ? 6 : 3,
  object_transfer: community ? 6 : 3,
  thumbnail_generate: community ? 4 : 2,
}

const PER_TYPE_BURST: Record<TaskTypeName, number> = {
  bulk_delete: community ? 32 : 16,
  object_transfer: community ? 24 : 12,
  thumbnail_generate: community ? 8 : 4,
}

const PER_TYPE_BUDGET_MS: Record<TaskTypeName, number> = {
  bulk_delete: community ? 30_000 : 15_000,
  object_transfer: community ? 30_000 : 15_000,
  thumbnail_generate: community ? 15_000 : 8_000,
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false
  }
  return defaultValue
}

function parseIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (!value) return defaultValue
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.min(max, Math.max(min, parsed))
}

export function isTaskEngineV2Enabled(): boolean {
  return parseBooleanEnv(process.env.TASK_ENGINE_V2, false)
}

export function getTaskWorkerConcurrency(): number {
  return parseIntegerEnv(process.env.TASK_WORKER_CONCURRENCY, community ? 24 : 12, 1, 128)
}

export function getTaskMaxActivePerUser(type?: TaskTypeName): number {
  if (type) {
    return parseIntegerEnv(
      process.env[`TASK_MAX_ACTIVE_PER_USER_${TYPE_ENV_SUFFIX[type]}`],
      PER_TYPE_MAX_ACTIVE[type],
      1,
      32,
    )
  }
  return parseIntegerEnv(process.env.TASK_MAX_ACTIVE_PER_USER, community ? 8 : 4, 1, 32)
}

export function getTaskWorkerUserBurst(type?: TaskTypeName): number {
  if (type) {
    return parseIntegerEnv(
      process.env[`TASK_WORKER_USER_BURST_${TYPE_ENV_SUFFIX[type]}`],
      PER_TYPE_BURST[type],
      1,
      64,
    )
  }
  return parseIntegerEnv(process.env.TASK_WORKER_USER_BURST, community ? 16 : 8, 1, 64)
}

export function getTaskWorkerUserBudgetMs(type?: TaskTypeName): number {
  if (type) {
    return parseIntegerEnv(
      process.env[`TASK_WORKER_USER_BUDGET_MS_${TYPE_ENV_SUFFIX[type]}`],
      PER_TYPE_BUDGET_MS[type],
      1_000,
      120_000,
    )
  }
  return parseIntegerEnv(process.env.TASK_WORKER_USER_BUDGET_MS, community ? 20_000 : 10_000, 1_000, 120_000)
}

export function getTaskTransferChunkSize(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_CHUNK_SIZE, community ? 100 : 50, 10, 500)
}

export function getTaskWorkerScanIntervalSeconds(): number {
  return parseIntegerEnv(process.env.TASK_WORKER_SCAN_INTERVAL_SECONDS, community ? 5 : 10, 2, 300)
}

export function getTaskMissedScheduleGraceSeconds(): number {
  return parseIntegerEnv(process.env.TASK_MISSED_SCHEDULE_GRACE_SECONDS, 120, 5, 86_400)
}

export function getTaskEventRetentionDays(): number {
  return parseIntegerEnv(process.env.TASK_EVENT_RETENTION_DAYS, 90, 7, 3650)
}

export function getTaskEngineInternalToken(): string {
  return (process.env.TASK_ENGINE_INTERNAL_TOKEN ?? "").trim()
}

export function getTaskWorkerAppUrl(): string {
  return (process.env.TASK_ENGINE_APP_URL ?? "http://app:3000").trim()
}
