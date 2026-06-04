import { isCommunityEdition } from "@/lib/edition"

const community = isCommunityEdition()

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
  return parseIntegerEnv(process.env.TASK_WORKER_CONCURRENCY, community ? 8 : 12, 1, 128)
}

export function getTaskMaxActivePerUser(): number {
  return parseIntegerEnv(process.env.TASK_MAX_ACTIVE_PER_USER, 4, 1, 32)
}

export function getTaskWorkerPerUserParallelism(): number {
  return parseIntegerEnv(process.env.TASK_WORKER_PER_USER_PARALLELISM, community ? 4 : 8, 1, 32)
}

export function getTaskWorkerUserBurst(): number {
  return parseIntegerEnv(process.env.TASK_WORKER_USER_BURST, community ? 4 : 8, 1, 64)
}

export function getTaskWorkerUserBudgetMs(): number {
  return parseIntegerEnv(process.env.TASK_WORKER_USER_BUDGET_MS, community ? 20_000 : 10_000, 1_000, 120_000)
}

export function getTaskWorkerScanIntervalSeconds(): number {
  return parseIntegerEnv(process.env.TASK_WORKER_SCAN_INTERVAL_SECONDS, community ? 5 : 10, 2, 300)
}

export function getTaskTransferItemConcurrency(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_ITEM_CONCURRENCY, community ? 4 : 8, 1, 32)
}

export function getTaskTransferBatchSize(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_BATCH_SIZE, 100, 10, 1_000)
}

export function getTaskTransferMultipartCopyPartConcurrency(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_MULTIPART_COPY_PART_CONCURRENCY, 4, 1, 32)
}

export function getTaskTransferRelayQueueSize(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_RELAY_QUEUE_SIZE, 2, 1, 32)
}

export function getTaskTransferRelayPartSizeMb(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_RELAY_PART_SIZE_MB, 16, 5, 256)
}

export function getTaskTransferPreferServerCopySameBackend(): boolean {
  return parseBooleanEnv(process.env.TASK_TRANSFER_PREFER_SERVER_COPY_SAME_BACKEND, true)
}

export function getTaskTransferProgressMinFileSizeMb(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_PROGRESS_MIN_FILE_SIZE_MB, 100, 1, 102_400)
}

export function getTaskTransferProgressSampleIntervalMs(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_PROGRESS_SAMPLE_INTERVAL_MS, 2_000, 250, 30_000)
}

export function getTaskTransferProgressSampleDeltaMb(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_PROGRESS_SAMPLE_DELTA_MB, 64, 1, 1_024)
}

export function getTaskTransferProgressMaxEventsPerFile(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_PROGRESS_MAX_EVENTS_PER_FILE, 200, 10, 2_000)
}

export function getTaskTransferItemRetryMaxAttempts(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_ITEM_RETRY_MAX_ATTEMPTS, 3, 0, 10)
}

export function getTaskTransferItemRetryBaseDelayMs(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_ITEM_RETRY_BASE_DELAY_MS, 1_000, 100, 30_000)
}

export function getTaskTransferVerifyChecksum(): boolean {
  return parseBooleanEnv(process.env.TASK_TRANSFER_VERIFY_CHECKSUM, true)
}

export function getTaskTransferBandwidthLimitMbps(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_BANDWIDTH_LIMIT_MBPS, 0, 0, 10_000)
}

export function getTaskTransferParallelChunkedDownloadThresholdMb(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_PARALLEL_DOWNLOAD_THRESHOLD_MB, 512, 0, 102_400)
}

export function getTaskTransferParallelDownloadStreams(): number {
  return parseIntegerEnv(process.env.TASK_TRANSFER_PARALLEL_DOWNLOAD_STREAMS, 2, 1, 16)
}

export function getTaskBulkDeleteBatchSize(): number {
  return parseIntegerEnv(process.env.TASK_BULK_DELETE_BATCH_SIZE, 1_000, 100, 5_000)
}

export function getTaskGlobalMaxActive(): number {
  return parseIntegerEnv(process.env.TASK_GLOBAL_MAX_ACTIVE, 0, 0, 10_000)
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
