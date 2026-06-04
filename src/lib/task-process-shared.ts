import { NextResponse } from "next/server"
import { DeleteObjectsCommand, type S3Client } from "@aws-sdk/client-s3"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db"
import {
  appendExecutionHistory,
  normalizeExecutionHistory,
  type TaskExecutionHistoryEntry,
} from "@/lib/task-plans"
import { isCommunityEdition } from "@/lib/edition"
import {
  nextRunAtForTaskSchedule,
  resolveTaskSchedule,
  type ResolvedTaskSchedule,
} from "@/lib/task-schedule"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LOCK_SECONDS = (() => {
  const raw = process.env.TASK_LOCK_SECONDS
  if (!raw) return 120
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return 120
  return Math.min(600, Math.max(30, parsed))
})()
export const SYNC_POLL_INTERVAL_SECONDS = 60
export const PAUSE_HOLD_MS = 365 * 24 * 60 * 60 * 1000
export const ONE_MEBIBYTE_BYTES = 1024 * 1024
export const ONE_MEBIBYTE_BIGINT = BigInt(ONE_MEBIBYTE_BYTES)
export const DEFAULT_MULTIPART_PART_SIZE_BYTES = 64 * ONE_MEBIBYTE_BYTES
export const DEFAULT_MULTIPART_PART_SIZE_BIGINT = BigInt(DEFAULT_MULTIPART_PART_SIZE_BYTES)
export const MAX_MULTIPART_PARTS = 10_000
export const MAX_RELAY_BUFFERED_BYTES = 512 * ONE_MEBIBYTE_BYTES
export const SINGLE_REQUEST_COPY_MAX_BYTES = BigInt(5 * 1024 * 1024 * 1024)

// ---------------------------------------------------------------------------
// Async semaphore — limits concurrency to N permits.
// ---------------------------------------------------------------------------

export class AsyncSemaphore {
  private permits: number
  private waiters: Array<() => void> = []

  constructor(permits: number) {
    this.permits = permits
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!
      next()
    } else {
      this.permits++
    }
  }
}

// ---------------------------------------------------------------------------
// Global relay memory budget
// ---------------------------------------------------------------------------
// Caps the total bytes buffered across all concurrent relay uploads in this
// process, preventing OOM when many large-file transfers run in parallel.
// When budget is full, callers wait instead of failing.

const RELAY_GLOBAL_BUDGET_BYTES = (() => {
  const raw = process.env.TASK_RELAY_GLOBAL_MEMORY_BUDGET_MB
  // Community edition: 512 MB (allows only 1 concurrent relay upload).
  // Cloud edition: 2 GB (allows several concurrent relays across users).
  const defaultMb = isCommunityEdition() ? 512 : 2_048
  if (!raw) return defaultMb * ONE_MEBIBYTE_BYTES
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return defaultMb * ONE_MEBIBYTE_BYTES
  return Math.min(16_384, Math.max(128, parsed)) * ONE_MEBIBYTE_BYTES
})()

let relayGlobalBytesInUse = 0
const relayBudgetWaiters: Array<{ bytes: number; resolve: () => void }> = []

/**
 * Reserve `bytes` from the global relay memory budget.
 * If the budget is full, the returned promise resolves once enough memory
 * is released — callers wait instead of failing.
 */
export async function reserveRelayMemory(bytes: number): Promise<void> {
  if (relayGlobalBytesInUse + bytes <= RELAY_GLOBAL_BUDGET_BYTES) {
    relayGlobalBytesInUse += bytes
    return
  }
  return new Promise<void>((resolve) => {
    relayBudgetWaiters.push({ bytes, resolve })
  })
}

/** Release previously reserved relay memory bytes and wake waiters. */
export function releaseRelayMemory(bytes: number): void {
  relayGlobalBytesInUse = Math.max(0, relayGlobalBytesInUse - bytes)
  // Drain waiters whose reservations now fit within the budget.
  while (relayBudgetWaiters.length > 0) {
    const next = relayBudgetWaiters[0]
    if (relayGlobalBytesInUse + next.bytes <= RELAY_GLOBAL_BUDGET_BYTES) {
      relayGlobalBytesInUse += next.bytes
      relayBudgetWaiters.shift()
      next.resolve()
    } else {
      break
    }
  }
}
export const TRANSFER_PROGRESS_MILESTONES = [25, 50, 75, 90, 100] as const
export const TRANSIENT_S3_ERROR_CODES = new Set([
  "SlowDown",
  "ServiceUnavailable",
  "InternalError",
  "RequestTimeout",
  "RequestTimeTooSkewed",
  "OperationAborted",
  "500",
  "502",
  "503",
  "504",
])

// ---------------------------------------------------------------------------
// Types & interfaces
// ---------------------------------------------------------------------------

export interface BulkDeleteTaskPayload {
  query: string
  selectedType: string
  selectedCredentialIds: string[]
  selectedBucketScopes: string[]
}

export interface BulkDeleteTaskProgress {
  total: number
  deleted: number
  remaining: number
  cursorId: string | null
}

export type TransferScope = "folder" | "bucket"
export type TransferOperation = "sync" | "copy" | "move" | "migrate"

export interface ObjectTransferTaskPayload {
  scope: TransferScope
  operation: TransferOperation
  sourceCredentialId: string
  sourceBucket: string
  sourcePrefix: string | null
  destinationCredentialId: string
  destinationBucket: string
  destinationPrefix: string | null
  pollIntervalSeconds: number | null
}

export interface ObjectTransferTaskProgress {
  phase: "transfer"
  total: number
  processed: number
  copied: number
  moved: number
  deleted: number
  skipped: number
  failed: number
  remaining: number
  cursorKey: string | null
  currentFileKey: string | null
  currentFileSizeBytes: string | null
  currentFileTransferredBytes: string | null
  currentFileStage: TransferProgressStage | null
  transferStrategy: TransferStrategy | null
  fallbackReason: string | null
  bytesProcessedTotal: string | null
  bytesEstimatedTotal: string | null
  throughputBytesPerSec: number | null
  etaSeconds: number | null
  lastProgressAt: string | null
}

export interface WorkerTaskSnapshot {
  taskId: string
  taskType: string
  taskStatus: string
  runCount: number
  attempts: number
  lastError: string | null
  taskUserId: string
}

export interface TransferSourceRow {
  id: string
  key: string
  extension: string
  size: bigint
  lastModified: Date
}

export interface TransferDestinationSnapshot {
  size: bigint
  lastModified: Date
}

export interface TransferMetadataUpsertRow {
  userId: string
  credentialId: string
  bucket: string
  key: string
  extension: string
  size: bigint
  lastModified: Date
}

export interface PreparedTransferItem {
  sourceFile: TransferSourceRow
  destinationKey: string
  createsNewDestination: boolean
  skip: boolean
  skipReason: TransferSkipReason | null
}

export interface TransferItemResult {
  status: "copied" | "moved" | "skipped" | "failed" | "missing_source"
  sourceId: string
  sourceKey: string
  destinationKey: string
  extension: string
  size: bigint
  lastModified: Date
  createsNewDestination: boolean
  sourceDeleteRequired: boolean
  errorMessage: string | null
}

export type TransferStrategy =
  | "single_request_server_copy"
  | "multipart_server_copy"
  | "multipart_relay_upload"

export type TransferProgressStage =
  | "queued"
  | "copying"
  | "deleting_source"
  | "finalizing"
  | "completed"
  | "failed"

export type TransferProgressSampleReason =
  | "interval"
  | "delta"
  | "milestone"
  | "stage_change"

export interface TransferTelemetryHooks {
  start?: (params: {
    sourceKey: string
    destinationKey: string
    strategy: TransferStrategy
    totalBytes: bigint | null
  }) => void | Promise<void>
  progress?: (params: {
    sourceKey: string
    destinationKey: string
    strategy: TransferStrategy
    transferredBytes: bigint
    totalBytes: bigint | null
    stage?: TransferProgressStage
  }) => void | Promise<void>
  stage?: (params: {
    sourceKey: string
    destinationKey: string
    strategy: TransferStrategy | null
    stage: TransferProgressStage
  }) => void | Promise<void>
  fallback?: (params: {
    sourceKey: string
    destinationKey: string
    reason: string
    nextStrategy: TransferStrategy
  }) => void | Promise<void>
  finish?: (params: {
    sourceKey: string
    destinationKey: string
    strategy: TransferStrategy | null
    status: "completed" | "failed"
  }) => void | Promise<void>
}

export type TransferSkipReason =
  | "already_exists"
  | "up_to_date"
  | "same_source_and_destination"
  | "cache_limit_reached"

export interface ClaimedTaskControlState {
  status: string
  lifecycleState: string
  pausedAt: Date | null
}

export interface PersistClaimedTaskCheckpointParams {
  taskId: string
  userId: string
  claimedRunCount: number
  normalUpdate: Prisma.BackgroundTaskUpdateManyMutationInput
  pauseUpdate?: Prisma.BackgroundTaskUpdateManyMutationInput
  cancelUpdate?: Prisma.BackgroundTaskUpdateManyMutationInput
  preferTerminal?: boolean
}

export interface PersistClaimedTaskCheckpointResult {
  applied: boolean
  appliedMode: "normal" | "paused" | "canceled"
  finalStatus: string
}

export interface RemoteObjectSnapshot {
  size: bigint | null
  lastModified: Date | null
}

export interface SyncDestinationDriftRow {
  key: string
}

// ---------------------------------------------------------------------------
// S3 error utilities (placed before callers that depend on them)
// ---------------------------------------------------------------------------

export function getS3ErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return ""
  const candidate = error as { Code?: unknown; code?: unknown; name?: unknown }

  if (typeof candidate.Code === "string") return candidate.Code
  if (typeof candidate.code === "string") return candidate.code
  if (typeof candidate.name === "string") return candidate.name
  return ""
}

export function isS3MissingObjectError(error: unknown): boolean {
  const code = getS3ErrorCode(error)
  if (
    code === "NoSuchKey" ||
    code === "NotFound" ||
    code === "NoSuchObject" ||
    code === "404"
  ) {
    return true
  }

  if (!error || typeof error !== "object") return false
  const candidate = error as {
    $metadata?: {
      httpStatusCode?: unknown
    }
  }
  return candidate.$metadata?.httpStatusCode === 404
}

// ---------------------------------------------------------------------------
// Payload parsers
// ---------------------------------------------------------------------------

export function parsePayload(raw: unknown): BulkDeleteTaskPayload | null {
  if (!raw || typeof raw !== "object") return null

  const payload = raw as {
    query?: unknown
    selectedType?: unknown
    selectedCredentialIds?: unknown
    selectedBucketScopes?: unknown
  }

  if (typeof payload.query !== "string" || payload.query.trim().length < 2) {
    return null
  }

  return {
    query: payload.query.trim(),
    selectedType: typeof payload.selectedType === "string" ? payload.selectedType : "all",
    selectedCredentialIds: Array.isArray(payload.selectedCredentialIds)
      ? payload.selectedCredentialIds.filter((value): value is string => typeof value === "string")
      : [],
    selectedBucketScopes: Array.isArray(payload.selectedBucketScopes)
      ? payload.selectedBucketScopes.filter((value): value is string => typeof value === "string")
      : [],
  }
}

export function parseProgress(raw: unknown, totalFallback = 0): BulkDeleteTaskProgress {
  if (!raw || typeof raw !== "object") {
    return {
      total: totalFallback,
      deleted: 0,
      remaining: totalFallback,
      cursorId: null,
    }
  }

  const progress = raw as {
    total?: unknown
    deleted?: unknown
    remaining?: unknown
    cursorId?: unknown
  }

  const total = typeof progress.total === "number" ? Math.max(0, Math.floor(progress.total)) : totalFallback
  const deleted = typeof progress.deleted === "number" ? Math.max(0, Math.floor(progress.deleted)) : 0
  const remaining = typeof progress.remaining === "number"
    ? Math.max(0, Math.floor(progress.remaining))
    : Math.max(0, total - deleted)

  return {
    total,
    deleted,
    remaining,
    cursorId:
      typeof progress.cursorId === "string" && progress.cursorId.trim().length > 0
        ? progress.cursorId
        : null,
  }
}

export function parseObjectTransferPayload(raw: unknown): ObjectTransferTaskPayload | null {
  if (!raw || typeof raw !== "object") return null

  const payload = raw as {
    scope?: unknown
    operation?: unknown
    sourceCredentialId?: unknown
    sourceBucket?: unknown
    sourcePrefix?: unknown
    destinationCredentialId?: unknown
    destinationBucket?: unknown
    destinationPrefix?: unknown
    pollIntervalSeconds?: unknown
  }

  const scope = payload.scope
  const operation = payload.operation
  if (scope !== "folder" && scope !== "bucket") return null
  if (
    operation !== "sync" &&
    operation !== "copy" &&
    operation !== "move" &&
    operation !== "migrate"
  ) {
    return null
  }

  if (typeof payload.sourceCredentialId !== "string" || !payload.sourceCredentialId.trim()) return null
  if (typeof payload.sourceBucket !== "string" || !payload.sourceBucket.trim()) return null
  if (typeof payload.destinationCredentialId !== "string" || !payload.destinationCredentialId.trim()) return null
  if (typeof payload.destinationBucket !== "string" || !payload.destinationBucket.trim()) return null

  const sourcePrefix =
    payload.sourcePrefix === null
      ? null
      : typeof payload.sourcePrefix === "string"
        ? payload.sourcePrefix
        : null
  const destinationPrefix =
    payload.destinationPrefix === null
      ? null
      : typeof payload.destinationPrefix === "string"
        ? payload.destinationPrefix
        : null

  const pollIntervalSeconds =
    typeof payload.pollIntervalSeconds === "number" &&
    Number.isFinite(payload.pollIntervalSeconds) &&
    payload.pollIntervalSeconds >= SYNC_POLL_INTERVAL_SECONDS
      ? Math.floor(payload.pollIntervalSeconds)
      : null

  return {
    scope,
    operation,
    sourceCredentialId: payload.sourceCredentialId.trim(),
    sourceBucket: payload.sourceBucket.trim(),
    sourcePrefix,
    destinationCredentialId: payload.destinationCredentialId.trim(),
    destinationBucket: payload.destinationBucket.trim(),
    destinationPrefix,
    pollIntervalSeconds,
  }
}

export function parseObjectTransferProgress(
  raw: unknown,
  totalFallback = 0
): ObjectTransferTaskProgress {
  if (!raw || typeof raw !== "object") {
    return {
      ...emptyTransferProgress(),
      total: totalFallback,
      remaining: totalFallback,
    }
  }

  const progress = raw as {
    phase?: unknown
    total?: unknown
    processed?: unknown
    copied?: unknown
    moved?: unknown
    deleted?: unknown
    skipped?: unknown
    failed?: unknown
    remaining?: unknown
    cursorKey?: unknown
    currentFileKey?: unknown
    currentFileSizeBytes?: unknown
    currentFileTransferredBytes?: unknown
    currentFileStage?: unknown
    transferStrategy?: unknown
    fallbackReason?: unknown
    bytesProcessedTotal?: unknown
    bytesEstimatedTotal?: unknown
    throughputBytesPerSec?: unknown
    etaSeconds?: unknown
    lastProgressAt?: unknown
  }

  const total =
    typeof progress.total === "number" ? Math.max(0, Math.floor(progress.total)) : totalFallback
  const processed =
    typeof progress.processed === "number" ? Math.max(0, Math.floor(progress.processed)) : 0
  const copied = typeof progress.copied === "number" ? Math.max(0, Math.floor(progress.copied)) : 0
  const moved = typeof progress.moved === "number" ? Math.max(0, Math.floor(progress.moved)) : 0
  const deleted = typeof progress.deleted === "number" ? Math.max(0, Math.floor(progress.deleted)) : 0
  const skipped = typeof progress.skipped === "number" ? Math.max(0, Math.floor(progress.skipped)) : 0
  const failed = typeof progress.failed === "number" ? Math.max(0, Math.floor(progress.failed)) : 0

  const remaining =
    typeof progress.remaining === "number"
      ? Math.max(0, Math.floor(progress.remaining))
      : Math.max(0, total - processed)

  return {
    phase: progress.phase === "transfer" ? "transfer" : "transfer",
    total,
    processed,
    copied,
    moved,
    deleted,
    skipped,
    failed,
    remaining,
    cursorKey: typeof progress.cursorKey === "string" && progress.cursorKey.length > 0
      ? progress.cursorKey
      : null,
    currentFileKey:
      typeof progress.currentFileKey === "string" && progress.currentFileKey.length > 0
        ? progress.currentFileKey
        : null,
    currentFileSizeBytes:
      typeof progress.currentFileSizeBytes === "string" && progress.currentFileSizeBytes.length > 0
        ? progress.currentFileSizeBytes
        : null,
    currentFileTransferredBytes:
      typeof progress.currentFileTransferredBytes === "string" &&
      progress.currentFileTransferredBytes.length > 0
        ? progress.currentFileTransferredBytes
        : null,
    currentFileStage:
      progress.currentFileStage === "queued" ||
      progress.currentFileStage === "copying" ||
      progress.currentFileStage === "deleting_source" ||
      progress.currentFileStage === "finalizing" ||
      progress.currentFileStage === "completed" ||
      progress.currentFileStage === "failed"
        ? progress.currentFileStage
        : null,
    transferStrategy:
      progress.transferStrategy === "single_request_server_copy" ||
      progress.transferStrategy === "multipart_server_copy" ||
      progress.transferStrategy === "multipart_relay_upload"
        ? progress.transferStrategy
        : null,
    fallbackReason:
      typeof progress.fallbackReason === "string" && progress.fallbackReason.length > 0
        ? progress.fallbackReason
        : null,
    bytesProcessedTotal:
      typeof progress.bytesProcessedTotal === "string" && progress.bytesProcessedTotal.length > 0
        ? progress.bytesProcessedTotal
        : null,
    bytesEstimatedTotal:
      typeof progress.bytesEstimatedTotal === "string" && progress.bytesEstimatedTotal.length > 0
        ? progress.bytesEstimatedTotal
        : null,
    throughputBytesPerSec:
      typeof progress.throughputBytesPerSec === "number" && Number.isFinite(progress.throughputBytesPerSec)
        ? Math.max(0, progress.throughputBytesPerSec)
        : null,
    etaSeconds:
      typeof progress.etaSeconds === "number" && Number.isFinite(progress.etaSeconds)
        ? Math.max(0, Math.floor(progress.etaSeconds))
        : null,
    lastProgressAt:
      typeof progress.lastProgressAt === "string" && progress.lastProgressAt.length > 0
        ? progress.lastProgressAt
        : null,
  }
}

export function emptyTransferProgress(): ObjectTransferTaskProgress {
  return {
    phase: "transfer",
    total: 0,
    processed: 0,
    copied: 0,
    moved: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    cursorKey: null,
    currentFileKey: null,
    currentFileSizeBytes: null,
    currentFileTransferredBytes: null,
    currentFileStage: null,
    transferStrategy: null,
    fallbackReason: null,
    bytesProcessedTotal: null,
    bytesEstimatedTotal: null,
    throughputBytesPerSec: null,
    etaSeconds: null,
    lastProgressAt: null,
  }
}

// ---------------------------------------------------------------------------
// Key / transform helpers
// ---------------------------------------------------------------------------

export function mapTransferDestinationKey(
  payload: ObjectTransferTaskPayload,
  sourceKey: string
): string {
  if (payload.scope === "bucket") {
    return sourceKey
  }

  const sourcePrefix = payload.sourcePrefix ?? ""
  const destinationPrefix = payload.destinationPrefix ?? ""
  if (!sourcePrefix || !sourceKey.startsWith(sourcePrefix)) {
    return `${destinationPrefix}${sourceKey}`
  }
  return `${destinationPrefix}${sourceKey.slice(sourcePrefix.length)}`
}

export function buildCopySource(bucket: string, key: string): string {
  // AWS SDK v3 does NOT correctly encode the x-amz-copy-source header
  // for keys with special characters (spaces, parentheses, non-ASCII).
  // See: https://github.com/aws/aws-sdk-js-v3/issues/6596
  //
  // encodeURI is insufficient: it does NOT encode #, ?, &, +, =, ;, :, @
  // which can break CopySource header parsing on S3-compatible providers
  // (notably Hetzner returns NoSuchKey for unencoded special chars).
  //
  // Use encodeURIComponent per path segment to encode all special chars
  // while preserving '/' separators.
  const encodedBucket = encodeURIComponent(bucket)
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `${encodedBucket}/${encodedKey}`
}

export function toValidContentLength(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null
    return Math.floor(value)
  }

  if (typeof value === "bigint") {
    const asNumber = Number(value)
    if (!Number.isSafeInteger(asNumber) || asNumber < 0) return null
    return asNumber
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed < 0) return null
    return parsed
  }

  return null
}

export function parseProgressBigint(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value >= BigInt(0) ? value : null
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null
    return BigInt(Math.floor(value))
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = BigInt(value)
      return parsed >= BigInt(0) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

export function bigintToNumberLossy(value: bigint): number {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value)
  }
  return Number.MAX_SAFE_INTEGER
}

// ---------------------------------------------------------------------------
// Error utilities
// ---------------------------------------------------------------------------

export function buildTransferFallbackReason(prefix: string, error: unknown): string {
  const code = getS3ErrorCode(error)
  const status = getS3ErrorStatus(error)
  const message = getS3ErrorMessage(error).trim()
  const requestId = getS3ErrorRequestId(error)
  const details = [
    code ? `code=${code}` : null,
    status !== null ? `status=${status}` : null,
    message ? `message=${message.slice(0, 180)}` : null,
    requestId ? `requestId=${requestId}` : null,
  ].filter((value): value is string => Boolean(value))
  if (details.length === 0) return prefix
  return `${prefix} (${details.join(", ")})`
}

/**
 * Build a detailed diagnostic string for transfer fallbacks that includes the
 * exact S3 command that failed, the parameters it was called with, and the full
 * error details. Shown in the UI and persisted in task events.
 */
export function buildDetailedFallbackReason(params: {
  action: string
  command: string
  commandParams: Record<string, string | undefined>
  error: unknown
  nextStrategy: string
}): string {
  const code = getS3ErrorCode(params.error)
  const status = getS3ErrorStatus(params.error)
  const message = getS3ErrorMessage(params.error).trim()
  const requestId = getS3ErrorRequestId(params.error)

  const errorParts = [
    code ? `code=${code}` : null,
    status !== null ? `status=${status}` : null,
    requestId ? `requestId=${requestId}` : null,
  ].filter(Boolean).join(", ")

  const cmdParams = Object.entries(params.commandParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")

  const lines = [
    `${params.action} → falling back to ${params.nextStrategy}`,
    `  command: ${params.command}(${cmdParams})`,
    errorParts ? `  error: ${errorParts}` : null,
    message ? `  message: ${message.slice(0, 300)}` : null,
  ].filter(Boolean).join("\n")

  return lines
}

export function getS3ErrorRequestId(error: unknown): string | null {
  if (!error || typeof error !== "object") return null
  const candidate = error as {
    $metadata?: { requestId?: unknown }
  }
  const id = candidate.$metadata?.requestId
  return typeof id === "string" && id.length > 0 ? id : null
}

export function getS3ErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  const candidate = error as {
    $metadata?: {
      httpStatusCode?: unknown
    }
  }
  return typeof candidate.$metadata?.httpStatusCode === "number"
    ? candidate.$metadata.httpStatusCode
    : null
}

export function getS3ErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return error instanceof Error ? error.message : ""
  }

  const candidate = error as {
    message?: unknown
    Message?: unknown
  }
  if (typeof candidate.message === "string") return candidate.message
  if (typeof candidate.Message === "string") return candidate.Message
  return error instanceof Error ? error.message : ""
}

export function isEntityTooLargeError(error: unknown): boolean {
  const code = getS3ErrorCode(error)
  if (code.includes("EntityTooLarge")) return true
  return getS3ErrorMessage(error).includes("EntityTooLarge")
}

export function isCopyCompatibilityFallbackError(error: unknown): boolean {
  const status = getS3ErrorStatus(error)
  if (status === 405 || status === 501) return true

  const code = getS3ErrorCode(error)
  return code.includes("NotImplemented") || code.includes("InvalidRequest")
}

export function isCopyAuthFallbackError(error: unknown): boolean {
  const status = getS3ErrorStatus(error)
  if (status === 401 || status === 403) return true

  const code = getS3ErrorCode(error)
  if (
    code.includes("AccessDenied") ||
    code.includes("Signature") ||
    code.includes("Authorization") ||
    code.includes("InvalidAccessKeyId") ||
    code.includes("ExpiredToken") ||
    code.includes("InvalidToken") ||
    code.includes("AuthFailure")
  ) {
    return true
  }

  const message = getS3ErrorMessage(error).toLowerCase()
  return (
    message.includes("access denied") ||
    message.includes("forbidden") ||
    message.includes("authorization") ||
    message.includes("signature")
  )
}

export function isTransientS3Error(error: unknown): boolean {
  const code = getS3ErrorCode(error)
  if (TRANSIENT_S3_ERROR_CODES.has(code)) return true

  if (error && typeof error === "object") {
    const candidate = error as { $metadata?: { httpStatusCode?: unknown } }
    const status = candidate.$metadata?.httpStatusCode
    if (typeof status === "number" && (status === 429 || status >= 500)) return true
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("epipe") ||
      message.includes("socket hang up") ||
      message.includes("network")
    ) {
      return true
    }
  }

  return false
}

export function computeRetryDelayMs(attempt: number, baseDelayMs: number): number {
  const delay = baseDelayMs * Math.pow(2, attempt)
  const jitter = delay * 0.2 * Math.random()
  return Math.floor(delay + jitter)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Task management utilities
// ---------------------------------------------------------------------------

export function formatTaskProcessingError(error: unknown): string {
  if (error instanceof Error && error.message && error.message !== "UnknownError") {
    return error.message
  }

  if (!error || typeof error !== "object") {
    if (error instanceof Error && error.message) return error.message
    return "Task processing failed"
  }

  const candidate = error as {
    name?: unknown
    code?: unknown
    Code?: unknown
    message?: unknown
    Message?: unknown
    $metadata?: unknown
  }

  const code =
    typeof candidate.Code === "string"
      ? candidate.Code
      : typeof candidate.code === "string"
        ? candidate.code
        : ""
  const name = typeof candidate.name === "string" ? candidate.name : ""
  const message =
    typeof candidate.message === "string"
      ? candidate.message
      : typeof candidate.Message === "string"
        ? candidate.Message
        : ""

  let status: number | null = null
  let requestId: string | null = null
  if (candidate.$metadata && typeof candidate.$metadata === "object") {
    const metadata = candidate.$metadata as {
      httpStatusCode?: unknown
      requestId?: unknown
    }
    if (typeof metadata.httpStatusCode === "number") {
      status = metadata.httpStatusCode
    }
    if (typeof metadata.requestId === "string" && metadata.requestId.trim()) {
      requestId = metadata.requestId.trim()
    }
  }

  const baseMessage =
    [message, code, name].find((value) => value && value !== "UnknownError") ??
    "UnknownError"

  const details: string[] = []
  if (status !== null) details.push(`status ${status}`)
  if (requestId) details.push(`request ${requestId}`)
  if (code && code !== baseMessage) details.push(`code ${code}`)
  if (name && name !== baseMessage && name !== code) details.push(`name ${name}`)

  return details.length > 0 ? `${baseMessage} (${details.join(", ")})` : baseMessage
}

export function formatTransferSkipReason(reason: TransferSkipReason): string {
  if (reason === "already_exists") return "already exists at destination"
  if (reason === "up_to_date") return "destination is up to date"
  if (reason === "same_source_and_destination") return "source and destination are identical"
  return "cache limit reached"
}

export function addTaskHistoryEntry(
  current: unknown,
  entry: Omit<TaskExecutionHistoryEntry, "at">
): Prisma.InputJsonValue {
  return appendExecutionHistory(current, {
    at: new Date().toISOString(),
    ...entry,
  }) as unknown as Prisma.InputJsonValue
}

export function buildProcessedResponse(
  snapshot: WorkerTaskSnapshot,
  body: Record<string, unknown> = {}
) {
  return NextResponse.json({
    processed: true,
    taskId: snapshot.taskId,
    taskType: snapshot.taskType,
    taskStatus: snapshot.taskStatus,
    runCount: snapshot.runCount,
    attempts: snapshot.attempts,
    lastError: snapshot.lastError,
    taskUserId: snapshot.taskUserId,
    ...body,
  })
}

export function snapshotFromCheckpoint(
  candidate: { id: string; type: string; runCount: number },
  actorUserId: string,
  checkpoint: PersistClaimedTaskCheckpointResult,
  overrides?: { attempts?: number; lastError?: string | null }
): WorkerTaskSnapshot {
  return {
    taskId: candidate.id,
    taskType: candidate.type,
    taskStatus: checkpoint.finalStatus,
    runCount: candidate.runCount + 1,
    attempts: overrides?.attempts ?? 0,
    lastError: overrides?.lastError ?? null,
    taskUserId: actorUserId,
  }
}

export function getBackgroundTaskStringFieldValue(
  value: string | Prisma.StringFieldUpdateOperationsInput | undefined
): string | null {
  if (typeof value === "string") return value
  if (
    value &&
    typeof value === "object" &&
    "set" in value &&
    typeof value.set === "string"
  ) {
    return value.set
  }
  return null
}

export async function loadClaimedTaskControlState(taskId: string): Promise<ClaimedTaskControlState | null> {
  return prisma.backgroundTask.findUnique({
    where: { id: taskId },
    select: {
      status: true,
      lifecycleState: true,
      pausedAt: true,
    },
  })
}

export function buildPauseCheckpointUpdate(
  normalUpdate: Prisma.BackgroundTaskUpdateManyMutationInput,
  now: Date,
  pausedAt: Date | null
): Prisma.BackgroundTaskUpdateManyMutationInput {
  return {
    ...normalUpdate,
    status: "pending",
    lifecycleState: "paused",
    pausedAt: pausedAt ?? now,
    nextRunAt: new Date(now.getTime() + PAUSE_HOLD_MS),
    completedAt: null,
  }
}

export function buildCancelCheckpointUpdate(
  normalUpdate: Prisma.BackgroundTaskUpdateManyMutationInput,
  now: Date
): Prisma.BackgroundTaskUpdateManyMutationInput {
  return {
    ...normalUpdate,
    status: "canceled",
    lifecycleState: "canceled",
    pausedAt: null,
    attempts: 0,
    lastError: null,
    completedAt: now,
    nextRunAt: now,
    isRecurring: false,
    scheduleCron: null,
    scheduleIntervalSeconds: null,
  }
}

export async function persistClaimedTaskCheckpoint(
  params: PersistClaimedTaskCheckpointParams
): Promise<PersistClaimedTaskCheckpointResult> {
  const now = new Date()
  const normalStatus = getBackgroundTaskStringFieldValue(params.normalUpdate.status) ?? "in_progress"
  const normalIsTerminal = normalStatus === "completed" || normalStatus === "failed"

  for (let attempt = 0; attempt < 3; attempt++) {
    const controlState = await loadClaimedTaskControlState(params.taskId)
    if (controlState && controlState.status !== "in_progress") {
      return {
        applied: false,
        appliedMode: "normal",
        finalStatus: controlState.status,
      }
    }

    let appliedMode: PersistClaimedTaskCheckpointResult["appliedMode"] = "normal"
    let selectedUpdate = params.normalUpdate

    if (!(params.preferTerminal && normalIsTerminal)) {
      if (controlState?.lifecycleState === "canceled") {
        appliedMode = "canceled"
        selectedUpdate = params.cancelUpdate ?? buildCancelCheckpointUpdate(params.normalUpdate, now)
      } else if (controlState?.lifecycleState === "paused") {
        appliedMode = "paused"
        selectedUpdate =
          params.pauseUpdate ??
          buildPauseCheckpointUpdate(params.normalUpdate, now, controlState.pausedAt)
      }
    }

    const applied = await prisma.backgroundTask.updateMany({
      where: {
        id: params.taskId,
        userId: params.userId,
        runCount: params.claimedRunCount,
        status: "in_progress",
        ...(controlState ? { lifecycleState: controlState.lifecycleState } : {}),
      },
      data: selectedUpdate,
    })

    const selectedStatus =
      getBackgroundTaskStringFieldValue(selectedUpdate.status) ?? normalStatus

    if (applied.count > 0) {
      return {
        applied: true,
        appliedMode,
        finalStatus: selectedStatus,
      }
    }
  }

  const current = await prisma.backgroundTask.findFirst({
    where: {
      id: params.taskId,
      userId: params.userId,
    },
    select: {
      status: true,
      lifecycleState: true,
    },
  })

  return {
    applied: false,
    appliedMode: current?.lifecycleState === "canceled"
      ? "canceled"
      : current?.lifecycleState === "paused"
        ? "paused"
        : "normal",
    finalStatus: current?.status ?? normalStatus,
  }
}

/**
 * Extend the lock on a claimed task without writing a full checkpoint.
 * Call this during long-running S3 operations (multipart relay/copy) to
 * prevent lock expiration while the worker is still actively processing.
 * Returns true if the lock was successfully extended.
 */
export async function refreshTaskLock(params: {
  taskId: string
  userId: string
  claimedRunCount: number
}): Promise<boolean> {
  const lockUntil = new Date(Date.now() + LOCK_SECONDS * 1000)
  const result = await prisma.backgroundTask.updateMany({
    where: {
      id: params.taskId,
      userId: params.userId,
      runCount: params.claimedRunCount,
      status: "in_progress",
    },
    data: {
      nextRunAt: lockUntil,
    },
  })
  return result.count > 0
}

export async function failTaskTerminal(params: {
  candidate: { id: string; type: string; runCount: number; attempts: number }
  actorUserId: string
  taskExecutionHistory: TaskExecutionHistoryEntry[]
  errorMessage: string
  extraResponseBody?: Record<string, unknown>
}): Promise<NextResponse> {
  const nextAttempts = params.candidate.attempts + 1
  const checkpoint = await persistClaimedTaskCheckpoint({
    taskId: params.candidate.id,
    userId: params.actorUserId,
    claimedRunCount: params.candidate.runCount + 1,
    preferTerminal: true,
    normalUpdate: {
      status: "failed",
      lifecycleState: "active",
      attempts: nextAttempts,
      lastError: params.errorMessage,
      completedAt: new Date(),
      nextRunAt: new Date(),
      executionHistory: addTaskHistoryEntry(params.taskExecutionHistory, {
        status: "failed",
        message: params.errorMessage,
      }),
    },
  })
  const canceled = checkpoint.appliedMode === "canceled"
  return buildProcessedResponse(
    snapshotFromCheckpoint(params.candidate, params.actorUserId, checkpoint, {
      attempts: canceled ? 0 : nextAttempts,
      lastError: canceled ? null : params.errorMessage,
    }),
    {
      done: true,
      error: params.errorMessage,
      ...params.extraResponseBody,
    }
  )
}

export async function upsertFileMetadataBatch(rows: TransferMetadataUpsertRow[]): Promise<void> {
  if (rows.length === 0) return

  const dedupedRows = Array.from(
    rows.reduce((map, row) => {
      map.set(`${row.credentialId}::${row.bucket}::${row.key}`, row)
      return map
    }, new Map<string, TransferMetadataUpsertRow>()).values()
  )
  if (dedupedRows.length === 0) return

  const values = Prisma.join(
    dedupedRows.map((row) => Prisma.sql`(
      ${crypto.randomUUID()},
      ${row.userId},
      ${row.credentialId},
      ${row.bucket},
      ${row.key},
      ${row.extension},
      ${row.size},
      ${row.lastModified},
      false
    )`)
  )

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "FileMetadata" (
      "id",
      "userId",
      "credentialId",
      "bucket",
      "key",
      "extension",
      "size",
      "lastModified",
      "isFolder"
    )
    VALUES ${values}
    ON CONFLICT ("credentialId", "bucket", "key")
    DO UPDATE SET
      "userId" = EXCLUDED."userId",
      "extension" = EXCLUDED."extension",
      "size" = EXCLUDED."size",
      "lastModified" = EXCLUDED."lastModified",
      "isFolder" = EXCLUDED."isFolder"
  `)
}

// ---------------------------------------------------------------------------
// resolveTaskPlanPayload — used by both transfer and bulk-delete
// ---------------------------------------------------------------------------

export function resolveTaskPlanPayload(executionPlan: unknown, fallbackPayload: unknown): unknown {
  if (!executionPlan || typeof executionPlan !== "object") {
    return fallbackPayload
  }

  const candidate = executionPlan as { payload?: unknown }
  return candidate.payload ?? fallbackPayload
}

// ---------------------------------------------------------------------------
// realignFutureRecurringRun — called from POST handler orchestrator
// ---------------------------------------------------------------------------

export async function realignFutureRecurringRun(params: {
  userId: string
  now: Date
  graceMs: number
}): Promise<boolean> {
  const { userId, now, graceMs } = params
  const candidate = await prisma.backgroundTask.findFirst({
    where: {
      userId,
      lifecycleState: "active",
      status: "pending",
      isRecurring: true,
      type: {
        in: ["bulk_delete", "object_transfer", "database_backup"],
      },
      nextRunAt: {
        gt: now,
      },
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      nextRunAt: true,
      scheduleCron: true,
      scheduleIntervalSeconds: true,
      executionHistory: true,
    },
  })

  if (!candidate) return false

  const schedule = resolveTaskSchedule({
    isRecurring: true,
    scheduleCron: candidate.scheduleCron,
    scheduleIntervalSeconds: candidate.scheduleIntervalSeconds,
  })
  if (!schedule.enabled) return false

  const expectedNextRunAt = nextRunAtForTaskSchedule(schedule, now)
  if (!expectedNextRunAt) return false

  if (candidate.nextRunAt.getTime() - expectedNextRunAt.getTime() <= graceMs) {
    return false
  }

  const updated = await prisma.backgroundTask.updateMany({
    where: {
      id: candidate.id,
      userId,
      lifecycleState: "active",
      status: "pending",
      nextRunAt: candidate.nextRunAt,
    },
    data: {
      nextRunAt: expectedNextRunAt,
      lastError: null,
      executionHistory: addTaskHistoryEntry(
        normalizeExecutionHistory(candidate.executionHistory),
        {
          status: "skipped",
          message: "Realigned scheduled run to server time",
          metadata: {
            previousNextRunAt: candidate.nextRunAt.toISOString(),
            nextRunAt: expectedNextRunAt.toISOString(),
            realignedAt: now.toISOString(),
          },
        }
      ),
    },
  })

  return updated.count > 0
}

// ---------------------------------------------------------------------------
// deleteKeysFromBucket — used by both transfer and bulk-delete
// ---------------------------------------------------------------------------

export async function deleteKeysFromBucket(
  client: InstanceType<typeof import("@aws-sdk/client-s3").S3Client>,
  bucket: string,
  keys: string[]
): Promise<Set<string>> {
  const deletedKeys = new Set<string>()

  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)

    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: false,
        },
      })
    )

    const deletedInResponse = (response.Deleted ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => Boolean(key))

    if (deletedInResponse.length > 0) {
      for (const key of deletedInResponse) {
        deletedKeys.add(key)
      }
      continue
    }

    const failedKeys = new Set(
      (response.Errors ?? [])
        .map((item) => item.Key)
        .filter((key): key is string => Boolean(key))
    )

    for (const key of batch) {
      if (!failedKeys.has(key)) {
        deletedKeys.add(key)
      }
    }
  }

  return deletedKeys
}
