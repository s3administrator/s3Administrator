import { NextResponse } from "next/server"
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from "@aws-sdk/client-s3"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { rebuildUserExtensionStats } from "@/lib/file-stats"
import { buildFileSearchSqlWhereClause, parseScopes } from "@/lib/file-search"
import { getMediaTypeFromExtension } from "@/lib/media"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import { getBucketLimitViolation } from "@/lib/plan-limits"
import { generateThumbnail } from "@/lib/thumbnail-worker"
import {
  buildLegacyThumbnailObjectKey,
  buildThumbnailObjectKey,
  buildThumbnailSourceMetadata,
  doesThumbnailMetadataMatchSource,
  getThumbnailMaxWidth,
  THUMBNAIL_SOURCE_LAST_MODIFIED_META_KEY,
  THUMBNAIL_SOURCE_SIZE_META_KEY,
  uploadThumbnailToSameBucket,
} from "@/lib/thumbnail-storage"
import { deleteMediaThumbnailsForKeys } from "@/lib/media-thumbnails"
import { isThumbnailCacheEnabledForUser } from "@/lib/thumbnail-cache-policy"
import {
  getObjectTransferDisabledMessage,
} from "@/lib/transfer-task-policy"
import { logUserAuditAction } from "@/lib/audit-logger"
import {
  getTaskEngineInternalToken,
  getTaskMaxActivePerUser,
  getTaskMissedScheduleGraceSeconds,
  getTaskTransferChunkSize,
  getTaskWorkerUserBudgetMs,
  type TaskTypeName,
} from "@/lib/task-engine-config"
import {
  appendExecutionHistory,
  normalizeExecutionHistory,
  type TaskExecutionHistoryEntry,
} from "@/lib/task-plans"
import {
  nextRunAtForTaskSchedule,
  resolveTaskSchedule,
  type ResolvedTaskSchedule,
} from "@/lib/task-schedule"
import { isDestinationUpToDateForSync } from "@/lib/transfer-delta"

export const runtime = "nodejs"
export const maxDuration = 60

const CHUNK_SIZE = 500
const LOCK_SECONDS = 45
const THUMBNAIL_TIMEOUT_MS = 5_000
const SYNC_POLL_INTERVAL_SECONDS = 60
const MAX_STALE_SCHEDULE_SKIPS_PER_CALL = 32

interface BulkDeleteTaskPayload {
  query: string
  selectedType: string
  selectedCredentialIds: string[]
  selectedBucketScopes: string[]
}

interface ThumbnailTaskPayload {
  bucket: string
  key: string
  credentialId: string
}

interface BulkDeleteTaskProgress {
  total: number
  deleted: number
  remaining: number
  cursorId: string | null
}

interface CountRow {
  total: bigint
}

type TransferScope = "folder" | "bucket"
type TransferOperation = "sync" | "copy" | "move" | "migrate"

interface ObjectTransferTaskPayload {
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

interface ObjectTransferTaskProgress {
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
}

function getTransferOperationDisabledMessage(
  scope: TransferScope,
  operation: TransferOperation
): string {
  if (operation === "sync") {
    return "Sync tasks are disabled for the current plan"
  }
  if (scope === "folder" && (operation === "copy" || operation === "move")) {
    return "Folder transfer tasks are disabled for the current plan"
  }
  if (scope === "bucket" && (operation === "copy" || operation === "migrate")) {
    return "Bucket transfer tasks are disabled for the current plan"
  }
  return "Transfer operation is disabled for the current plan"
}

function isTransferOperationEnabledByPlan(
  entitlements: {
    syncTasks: boolean
    copyFolderToFolder: boolean
    copyBucketToBucket: boolean
  },
  scope: TransferScope,
  operation: TransferOperation
): boolean {
  if (operation === "sync") {
    return entitlements.syncTasks
  }
  if (scope === "folder" && (operation === "copy" || operation === "move")) {
    return entitlements.copyFolderToFolder
  }
  if (scope === "bucket" && (operation === "copy" || operation === "migrate")) {
    return entitlements.copyBucketToBucket
  }
  return false
}

function parsePayload(raw: unknown): BulkDeleteTaskPayload | null {
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

function parseThumbnailPayload(raw: unknown): ThumbnailTaskPayload | null {
  if (!raw || typeof raw !== "object") return null

  const payload = raw as {
    bucket?: unknown
    key?: unknown
    credentialId?: unknown
  }

  if (typeof payload.bucket !== "string" || !payload.bucket.trim()) return null
  if (typeof payload.key !== "string" || !payload.key.trim()) return null
  if (typeof payload.credentialId !== "string" || !payload.credentialId.trim()) return null

  return {
    bucket: payload.bucket.trim(),
    key: payload.key.trim(),
    credentialId: payload.credentialId.trim(),
  }
}

function parseProgress(raw: unknown, totalFallback = 0): BulkDeleteTaskProgress {
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

function parseObjectTransferPayload(raw: unknown): ObjectTransferTaskPayload | null {
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

  if (scope === "folder") {
    if (!sourcePrefix || !destinationPrefix) {
      return null
    }
  }

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

function parseObjectTransferProgress(
  raw: unknown,
  totalFallback = 0
): ObjectTransferTaskProgress {
  if (!raw || typeof raw !== "object") {
    return {
      phase: "transfer",
      total: totalFallback,
      processed: 0,
      copied: 0,
      moved: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      remaining: totalFallback,
      cursorKey: null,
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
  }
}

function mapTransferDestinationKey(
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

function buildCopySource(bucket: string, key: string): string {
  const encodedBucket = encodeURIComponent(bucket)
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `${encodedBucket}/${encodedKey}`
}

function toValidContentLength(value: unknown): number | null {
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

interface RemoteObjectSnapshot {
  size: bigint | null
  lastModified: Date | null
}

function getS3ErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return ""
  const candidate = error as { Code?: unknown; code?: unknown; name?: unknown }

  if (typeof candidate.Code === "string") return candidate.Code
  if (typeof candidate.code === "string") return candidate.code
  if (typeof candidate.name === "string") return candidate.name
  return ""
}

function isS3MissingObjectError(error: unknown): boolean {
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

async function readRemoteObjectSnapshot(params: {
  client: S3Client
  bucket: string
  key: string
}): Promise<RemoteObjectSnapshot | null> {
  try {
    const response = await params.client.send(
      new HeadObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
      })
    )

    const size = toValidContentLength(response.ContentLength)
    const lastModified = response.LastModified instanceof Date ? response.LastModified : null

    return {
      size: size === null ? null : BigInt(size),
      lastModified,
    }
  } catch (error) {
    if (isS3MissingObjectError(error)) {
      return null
    }
    throw error
  }
}

function formatTaskProcessingError(error: unknown): string {
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

function addTaskHistoryEntry(
  current: unknown,
  entry: Omit<TaskExecutionHistoryEntry, "at">
): Prisma.InputJsonValue {
  return appendExecutionHistory(current, {
    at: new Date().toISOString(),
    ...entry,
  }) as unknown as Prisma.InputJsonValue
}

async function realignFutureRecurringRun(params: {
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
        in: ["bulk_delete", "thumbnail_generate", "object_transfer"],
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

function resolveTaskPlanPayload(executionPlan: unknown, fallbackPayload: unknown): unknown {
  if (!executionPlan || typeof executionPlan !== "object") {
    return fallbackPayload
  }

  const candidate = executionPlan as { payload?: unknown }
  return candidate.payload ?? fallbackPayload
}

async function copyObjectAcrossLocations(params: {
  sourceClient: S3Client
  destinationClient: S3Client
  sameCredential: boolean
  sourceBucket: string
  sourceKey: string
  destinationBucket: string
  destinationKey: string
  expectedContentLength?: unknown
}) {
  if (params.sameCredential) {
    try {
      await params.destinationClient.send(
        new CopyObjectCommand({
          Bucket: params.destinationBucket,
          CopySource: buildCopySource(params.sourceBucket, params.sourceKey),
          Key: params.destinationKey,
        })
      )
      return
    } catch {
      // Some S3-compatible providers fail CopyObject unexpectedly.
      // Fall back to streaming through this server.
    }
  }

  const sourceObject = await params.sourceClient.send(
    new GetObjectCommand({
      Bucket: params.sourceBucket,
      Key: params.sourceKey,
    })
  )

  if (!sourceObject.Body) {
    throw new Error(`Missing source object body for key '${params.sourceKey}'`)
  }

  let body = sourceObject.Body as PutObjectCommandInput["Body"]
  let contentLength =
    toValidContentLength(sourceObject.ContentLength) ??
    toValidContentLength(params.expectedContentLength)

  if (contentLength === null) {
    const bodyWithTransform = sourceObject.Body as {
      transformToByteArray?: () => Promise<Uint8Array>
    }
    if (typeof bodyWithTransform.transformToByteArray === "function") {
      const bytes = await bodyWithTransform.transformToByteArray()
      body = bytes
      contentLength = bytes.byteLength
    }
  }

  const putInput: PutObjectCommandInput = {
    Bucket: params.destinationBucket,
    Key: params.destinationKey,
    Body: body,
    ContentType: sourceObject.ContentType,
    CacheControl: sourceObject.CacheControl,
  }
  if (contentLength !== null) {
    putInput.ContentLength = contentLength
  }

  await params.destinationClient.send(
    new PutObjectCommand(putInput)
  )
}

async function deleteKeysFromBucket(
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

interface SyncDestinationDriftRow {
  key: string
}

async function findSyncDestinationDriftBatch(params: {
  userId: string
  payload: ObjectTransferTaskPayload
  chunkSize: number
}): Promise<SyncDestinationDriftRow[]> {
  const { userId, payload, chunkSize } = params

  if (payload.scope === "bucket") {
    return prisma.$queryRaw<SyncDestinationDriftRow[]>(Prisma.sql`
      SELECT d."key"
      FROM "FileMetadata" d
      WHERE d."userId" = ${userId}
        AND d."credentialId" = ${payload.destinationCredentialId}
        AND d."bucket" = ${payload.destinationBucket}
        AND d."isFolder" = false
        AND NOT EXISTS (
          SELECT 1
          FROM "FileMetadata" s
          WHERE s."userId" = ${userId}
            AND s."credentialId" = ${payload.sourceCredentialId}
            AND s."bucket" = ${payload.sourceBucket}
            AND s."isFolder" = false
            AND s."key" = d."key"
        )
      ORDER BY d."key" ASC
      LIMIT ${chunkSize}
    `)
  }

  const sourcePrefix = payload.sourcePrefix ?? ""
  const destinationPrefix = payload.destinationPrefix ?? ""
  const destinationPrefixLength = destinationPrefix.length
  const substringStart = destinationPrefixLength + 1

  return prisma.$queryRaw<SyncDestinationDriftRow[]>(Prisma.sql`
    SELECT d."key"
    FROM "FileMetadata" d
    WHERE d."userId" = ${userId}
      AND d."credentialId" = ${payload.destinationCredentialId}
      AND d."bucket" = ${payload.destinationBucket}
      AND d."isFolder" = false
      AND LEFT(d."key", ${destinationPrefixLength}) = ${destinationPrefix}
      AND NOT EXISTS (
        SELECT 1
        FROM "FileMetadata" s
        WHERE s."userId" = ${userId}
          AND s."credentialId" = ${payload.sourceCredentialId}
          AND s."bucket" = ${payload.sourceBucket}
          AND s."isFolder" = false
          AND s."key" = ${sourcePrefix} || substring(d."key" from ${substringStart})
      )
    ORDER BY d."key" ASC
    LIMIT ${chunkSize}
  `)
}

async function cleanupSyncDestinationDrift(params: {
  userId: string
  payload: ObjectTransferTaskPayload
  destinationClient: S3Client
}): Promise<{ deleted: number; failed: number }> {
  const { userId, payload, destinationClient } = params
  let deleted = 0
  let failed = 0

  while (true) {
    const driftRows = await findSyncDestinationDriftBatch({ userId, payload, chunkSize: getTaskTransferChunkSize() })
    if (driftRows.length === 0) {
      break
    }

    const driftKeys = driftRows.map((row) => row.key)
    const deletedKeys = await deleteKeysFromBucket(
      destinationClient,
      payload.destinationBucket,
      driftKeys
    )
    if (deletedKeys.size === 0) {
      failed += driftKeys.length
      break
    }

    const deletedKeyList = Array.from(deletedKeys)
    await prisma.fileMetadata.deleteMany({
      where: {
        userId,
        credentialId: payload.destinationCredentialId,
        bucket: payload.destinationBucket,
        key: { in: deletedKeyList },
      },
    })
    await deleteMediaThumbnailsForKeys({
      userId,
      credentialId: payload.destinationCredentialId,
      bucket: payload.destinationBucket,
      keys: deletedKeyList,
    })

    deleted += deletedKeyList.length
    failed += Math.max(0, driftKeys.length - deletedKeys.size)
  }

  return { deleted, failed }
}

export async function POST(request: Request) {
  let claimedTask:
    | {
      id: string
      type: string
      attempts: number
      maxAttempts: number
    }
    | null = null
  let userId: string | null = null
  let thumbnailPayload: ThumbnailTaskPayload | null = null
  let transferPayload: ObjectTransferTaskPayload | null = null
  let taskExecutionHistory: TaskExecutionHistoryEntry[] = []
  let claimedTaskSchedule: ResolvedTaskSchedule | null = null

  try {
    const internalToken = getTaskEngineInternalToken()
    const requestToken = (request.headers.get("x-task-engine-token") ?? "").trim()
    const requestedUserId = (new URL(request.url).searchParams.get("userId") ?? "").trim()

    if (internalToken && requestToken === internalToken && requestedUserId) {
      userId = requestedUserId
    } else {
      const session = await auth()
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      }
      userId = session.user.id
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const actorUserId = userId

    const TASK_TYPES = ["bulk_delete", "thumbnail_generate", "object_transfer"] as const
    const requestedType = (new URL(request.url).searchParams.get("type") ?? "").trim()
    const typeFilter = requestedType && TASK_TYPES.includes(requestedType as typeof TASK_TYPES[number])
      ? [requestedType]
      : [...TASK_TYPES]

    const now = new Date()

    const lockedByType = await prisma.backgroundTask.groupBy({
      by: ["type"],
      where: {
        userId: actorUserId,
        lifecycleState: "active",
        status: "in_progress",
        nextRunAt: { gt: now },
      },
      _count: { _all: true },
    })

    const lockedCounts = new Map(lockedByType.map((r) => [r.type, r._count._all]))
    const totalLocked = lockedByType.reduce((sum, r) => sum + r._count._all, 0)
    const requestedTypeName = typeFilter.length === 1 ? typeFilter[0] as TaskTypeName : null

    if (requestedTypeName) {
      const maxForType = getTaskMaxActivePerUser(requestedTypeName)
      const lockedForType = lockedCounts.get(requestedTypeName) ?? 0
      if (lockedForType >= maxForType) {
        return NextResponse.json({
          processed: false,
          message: "Task concurrency limit reached for user",
        })
      }
    } else {
      const totalMax = TASK_TYPES.reduce(
        (sum, t) => sum + getTaskMaxActivePerUser(t as TaskTypeName),
        0,
      )
      if (totalLocked >= totalMax) {
        return NextResponse.json({
          processed: false,
          message: "Task concurrency limit reached for user",
        })
      }
    }

    const staleScheduleGraceMs = getTaskMissedScheduleGraceSeconds() * 1000
    const realignedFutureSchedule = await realignFutureRecurringRun({
      userId: actorUserId,
      now,
      graceMs: staleScheduleGraceMs,
    })
    let skippedStaleSchedules = 0
    let candidate: Awaited<ReturnType<typeof prisma.backgroundTask.findFirst>> = null

    for (let index = 0; index < MAX_STALE_SCHEDULE_SKIPS_PER_CALL; index++) {
      const nextCandidate = await prisma.backgroundTask.findFirst({
        where: {
          userId: actorUserId,
          lifecycleState: "active",
          type: {
            in: typeFilter,
          },
          status: {
            in: ["pending", "in_progress"],
          },
          nextRunAt: {
            lte: now,
          },
        },
        orderBy: {
          createdAt: "asc",
        },
      })

      if (!nextCandidate) {
        break
      }

      const scheduled = resolveTaskSchedule(nextCandidate)
      const shouldSkipStaleRun =
        nextCandidate.status === "pending" &&
        scheduled.enabled &&
        now.getTime() - nextCandidate.nextRunAt.getTime() > staleScheduleGraceMs

      if (!shouldSkipStaleRun) {
        candidate = nextCandidate
        break
      }

      const nextRunAt =
        nextRunAtForTaskSchedule(scheduled, now) ??
        new Date(now.getTime() + SYNC_POLL_INTERVAL_SECONDS * 1000)
      const moved = await prisma.backgroundTask.updateMany({
        where: {
          id: nextCandidate.id,
          userId: actorUserId,
          lifecycleState: "active",
          status: "pending",
          nextRunAt: {
            lte: now,
          },
        },
        data: {
          nextRunAt,
          lastError: null,
          executionHistory: addTaskHistoryEntry(
            normalizeExecutionHistory(nextCandidate.executionHistory),
            {
              status: "skipped",
              message: "Skipped stale scheduled run after downtime",
              metadata: {
                previousNextRunAt: nextCandidate.nextRunAt.toISOString(),
                nextRunAt: nextRunAt.toISOString(),
                skippedAt: now.toISOString(),
              },
            }
          ),
        },
      })
      if (moved.count > 0) {
        skippedStaleSchedules += 1
      }
    }

    if (!candidate) {
      if (skippedStaleSchedules > 0) {
        return NextResponse.json({
          processed: false,
          message: "Skipped stale scheduled runs",
          skippedStaleSchedules,
        })
      }
      if (realignedFutureSchedule) {
        return NextResponse.json({
          processed: false,
          message: "Realigned future scheduled run to server time",
        })
      }
      return NextResponse.json({ processed: false, message: "No pending tasks" })
    }

    const lockUntil = new Date(Date.now() + LOCK_SECONDS * 1000)
    const claimed = await prisma.backgroundTask.updateMany({
      where: {
        id: candidate.id,
        userId: actorUserId,
        lifecycleState: "active",
        status: {
          in: ["pending", "in_progress"],
        },
        nextRunAt: {
          lte: now,
        },
      },
      data: {
        status: "in_progress",
        startedAt: candidate.startedAt ?? now,
        runCount: {
          increment: 1,
        },
        lastRunAt: now,
        nextRunAt: lockUntil,
      },
    })

    if (claimed.count === 0) {
      return NextResponse.json({ processed: false, message: "Task is already being processed" })
    }
    claimedTask = {
      id: candidate.id,
      type: candidate.type,
      attempts: candidate.attempts,
      maxAttempts: candidate.maxAttempts,
    }
    claimedTaskSchedule = resolveTaskSchedule(candidate)
    taskExecutionHistory = normalizeExecutionHistory(candidate.executionHistory)

    if (candidate.type === "thumbnail_generate") {
      const planPayload = resolveTaskPlanPayload(candidate.executionPlan, candidate.payload)
      thumbnailPayload = parseThumbnailPayload(planPayload)
      if (!thumbnailPayload) {
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "failed",
            attempts: candidate.attempts + 1,
            lastError: "Invalid thumbnail payload",
            completedAt: new Date(),
            nextRunAt: new Date(),
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "failed",
              message: "Invalid thumbnail payload",
            }),
          },
        })
        return NextResponse.json({ processed: false, message: "Invalid thumbnail payload" })
      }

      const thumbnailCacheEnabled = await isThumbnailCacheEnabledForUser(actorUserId)
      if (!thumbnailCacheEnabled) {
        await deleteMediaThumbnailsForKeys({
          userId: actorUserId,
          credentialId: thumbnailPayload.credentialId,
          bucket: thumbnailPayload.bucket,
          keys: [thumbnailPayload.key],
        })

        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "completed",
            attempts: 0,
            completedAt: new Date(),
            nextRunAt: new Date(),
            lastError: null,
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "skipped",
              message: "Thumbnail task skipped because thumbnail cache is disabled",
            }),
          },
        })

        await logUserAuditAction({
          userId: actorUserId,
          eventType: "s3_action",
          eventName: "thumbnail_generate_skipped",
          path: "/api/tasks/process",
          method: "POST",
          target: thumbnailPayload.key,
          metadata: {
            bucket: thumbnailPayload.bucket,
            credentialId: thumbnailPayload.credentialId,
            reason: "thumbnail_cache_disabled_for_plan",
          },
        })

        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
          skipped: "thumbnail_cache_disabled",
        })
      }

      const { client } = await getS3Client(actorUserId, thumbnailPayload.credentialId)
      const sourceFile = await prisma.fileMetadata.findFirst({
        where: {
          userId: actorUserId,
          credentialId: thumbnailPayload.credentialId,
          bucket: thumbnailPayload.bucket,
          key: thumbnailPayload.key,
          isFolder: false,
        },
        select: {
          extension: true,
          size: true,
          lastModified: true,
        },
      })

      if (!sourceFile) {
        await prisma.mediaThumbnail.updateMany({
          where: {
            userId: actorUserId,
            credentialId: thumbnailPayload.credentialId,
            bucket: thumbnailPayload.bucket,
            key: thumbnailPayload.key,
          },
          data: {
            status: "failed",
            lastError: "Source file is missing",
          },
        })
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "completed",
            attempts: 0,
            completedAt: new Date(),
            nextRunAt: new Date(),
            lastError: null,
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "skipped",
              message: "Thumbnail source file is missing",
            }),
          },
        })
        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
          skipped: "source_missing",
        })
      }

      const mediaType = getMediaTypeFromExtension(sourceFile.extension)
      if (mediaType !== "video" && mediaType !== "image") {
        await prisma.mediaThumbnail.updateMany({
          where: {
            userId: actorUserId,
            credentialId: thumbnailPayload.credentialId,
            bucket: thumbnailPayload.bucket,
            key: thumbnailPayload.key,
          },
          data: {
            status: "failed",
            lastError: "Unsupported media type for thumbnail generation",
          },
        })
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "completed",
            attempts: 0,
            completedAt: new Date(),
            nextRunAt: new Date(),
            lastError: null,
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "skipped",
              message: "Unsupported media type for thumbnail generation",
            }),
          },
        })
        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
          skipped: "unsupported_type",
        })
      }

      const sourceLastModified = sourceFile.lastModified
      const sourceSize = sourceFile.size
      const sourceMetadata = buildThumbnailSourceMetadata({
        sourceLastModified,
        sourceSize,
      })
      const thumbnailKey = buildThumbnailObjectKey({
        bucket: thumbnailPayload.bucket,
        key: thumbnailPayload.key,
        sourceLastModified,
        sourceSize,
      })
      const legacyThumbnailKey = buildLegacyThumbnailObjectKey({
        bucket: thumbnailPayload.bucket,
        key: thumbnailPayload.key,
        sourceLastModified,
        sourceSize,
      })
      const thumbnailBucket = thumbnailPayload.bucket

      await prisma.mediaThumbnail.upsert({
        where: {
          userId_credentialId_bucket_key: {
            userId: actorUserId,
            credentialId: thumbnailPayload.credentialId,
            bucket: thumbnailPayload.bucket,
            key: thumbnailPayload.key,
          },
        },
        create: {
          userId: actorUserId,
          credentialId: thumbnailPayload.credentialId,
          bucket: thumbnailPayload.bucket,
          key: thumbnailPayload.key,
          status: "processing",
          thumbnailBucket,
          thumbnailKey,
          mimeType: "image/webp",
          sourceLastModified,
          sourceSize,
          lastError: null,
        },
        update: {
          status: "processing",
          thumbnailBucket,
          thumbnailKey,
          mimeType: "image/webp",
          sourceLastModified,
          sourceSize,
          lastError: null,
        },
      })

      const queueLagMs = Math.max(0, Date.now() - candidate.createdAt.getTime())

      // Reuse existing thumbnails by deterministic object key, including legacy-key fallback.
      let reusableThumbnailFound = false
      let reusableThumbnailKey = thumbnailKey
      let requiresLegacyCopy = false
      try {
        const head = await client.send(new HeadObjectCommand({
          Bucket: thumbnailPayload.bucket,
          Key: thumbnailKey,
        }))
        reusableThumbnailFound = doesThumbnailMetadataMatchSource(head.Metadata, {
          sourceLastModified,
          sourceSize,
        })
      } catch {
        reusableThumbnailFound = false
      }

      if (!reusableThumbnailFound && legacyThumbnailKey !== thumbnailKey) {
        try {
          const legacyHead = await client.send(new HeadObjectCommand({
            Bucket: thumbnailPayload.bucket,
            Key: legacyThumbnailKey,
          }))
          const legacyHasSourceMetadata =
            Boolean(legacyHead.Metadata?.[THUMBNAIL_SOURCE_LAST_MODIFIED_META_KEY]) &&
            Boolean(legacyHead.Metadata?.[THUMBNAIL_SOURCE_SIZE_META_KEY])
          const legacyMatches = legacyHasSourceMetadata
            ? doesThumbnailMetadataMatchSource(legacyHead.Metadata, {
                sourceLastModified,
                sourceSize,
              })
            : true
          if (legacyMatches) {
            reusableThumbnailFound = true
            reusableThumbnailKey = legacyThumbnailKey
            requiresLegacyCopy = true
          }
        } catch {
          reusableThumbnailFound = false
        }
      }

      if (reusableThumbnailFound) {
        if (requiresLegacyCopy) {
          try {
            await client.send(
              new CopyObjectCommand({
                Bucket: thumbnailPayload.bucket,
                Key: thumbnailKey,
                CopySource: encodeURIComponent(`${thumbnailPayload.bucket}/${reusableThumbnailKey}`),
                CacheControl: "public, max-age=31536000, immutable",
                ContentType: "image/webp",
                MetadataDirective: "REPLACE",
                Metadata: sourceMetadata,
              })
            )
          } catch {
            // Best effort copy; keep using legacy object key when copy is denied.
            reusableThumbnailKey = legacyThumbnailKey
          }
        }

        await prisma.mediaThumbnail.update({
          where: {
            userId_credentialId_bucket_key: {
              userId: actorUserId,
              credentialId: thumbnailPayload.credentialId,
              bucket: thumbnailPayload.bucket,
              key: thumbnailPayload.key,
            },
          },
          data: {
            status: "ready",
            thumbnailBucket,
            thumbnailKey: reusableThumbnailKey,
            mimeType: "image/webp",
            sourceLastModified,
            sourceSize,
            lastError: null,
          },
        })

        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "completed",
            attempts: 0,
            completedAt: new Date(),
            nextRunAt: new Date(),
            lastError: null,
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "succeeded",
              message: "Thumbnail already exists in S3; reused existing object",
              metadata: { queueLagMs },
            }),
          },
        })

        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
        })
      }

      const generated = await generateThumbnail({
        client,
        bucket: thumbnailPayload.bucket,
        key: thumbnailPayload.key,
        mediaType,
        maxWidth: getThumbnailMaxWidth(),
        timeoutMs: THUMBNAIL_TIMEOUT_MS,
        sourceSize,
      })

      const stillEnabled = await isThumbnailCacheEnabledForUser(actorUserId)
      if (!stillEnabled) {
        await deleteMediaThumbnailsForKeys({
          userId: actorUserId,
          credentialId: thumbnailPayload.credentialId,
          bucket: thumbnailPayload.bucket,
          keys: [thumbnailPayload.key],
        })

        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "completed",
            attempts: 0,
            completedAt: new Date(),
            nextRunAt: new Date(),
            lastError: null,
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "skipped",
              message: "Thumbnail task skipped because thumbnail cache was disabled during run",
            }),
          },
        })

        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
          skipped: "thumbnail_cache_disabled",
        })
      }

      await uploadThumbnailToSameBucket({
        client,
        bucket: thumbnailPayload.bucket,
        key: thumbnailKey,
        body: generated.buffer,
        contentType: generated.mimeType,
        metadata: sourceMetadata,
      })

      await prisma.mediaThumbnail.update({
        where: {
          userId_credentialId_bucket_key: {
            userId: actorUserId,
            credentialId: thumbnailPayload.credentialId,
            bucket: thumbnailPayload.bucket,
            key: thumbnailPayload.key,
          },
        },
        data: {
          status: "ready",
          thumbnailBucket,
          thumbnailKey,
          mimeType: generated.mimeType,
          sourceLastModified,
          sourceSize,
          lastError: null,
        },
      })

      await prisma.backgroundTask.update({
        where: { id: candidate.id },
        data: {
          status: "completed",
          attempts: 0,
          completedAt: new Date(),
          nextRunAt: new Date(),
          lastError: null,
          executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
            status: "succeeded",
            message: "Thumbnail generated successfully",
            metadata: {
              durationMs: generated.durationMs,
              queueLagMs,
            },
          }),
        },
      })

      await logUserAuditAction({
        userId: actorUserId,
        eventType: "s3_action",
        eventName: "thumbnail_generate",
        path: "/api/tasks/process",
        method: "POST",
        target: thumbnailPayload.key,
        metadata: {
          bucket: thumbnailPayload.bucket,
          credentialId: thumbnailPayload.credentialId,
          durationMs: generated.durationMs,
          queueLagMs,
        },
      })

      return NextResponse.json({
        processed: true,
        taskId: candidate.id,
        done: true,
        type: "thumbnail_generate",
      })
    }

    if (candidate.type === "object_transfer") {
      const planPayload = resolveTaskPlanPayload(candidate.executionPlan, candidate.payload)
      transferPayload = parseObjectTransferPayload(planPayload)
      if (!transferPayload) {
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "failed",
            attempts: candidate.attempts + 1,
            lastError: "Invalid object transfer payload",
            completedAt: new Date(),
            nextRunAt: new Date(),
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "failed",
              message: "Invalid object transfer payload",
            }),
          },
        })
        return NextResponse.json({ processed: false, message: "Invalid object transfer payload" })
      }

      const entitlements = await getUserPlanEntitlements(actorUserId)
      if (!entitlements || !entitlements.transferTasks) {
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "failed",
            attempts: candidate.attempts + 1,
            completedAt: new Date(),
            nextRunAt: new Date(),
            lastError: getObjectTransferDisabledMessage(),
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "failed",
              message: getObjectTransferDisabledMessage(),
            }),
          },
        })

        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
          type: "object_transfer",
          skipped: "transfer_disabled_for_plan",
        })
      }

      if (
        !isTransferOperationEnabledByPlan(
          entitlements,
          transferPayload.scope,
          transferPayload.operation
        )
      ) {
        const message = getTransferOperationDisabledMessage(
          transferPayload.scope,
          transferPayload.operation
        )
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "failed",
            attempts: candidate.attempts + 1,
            completedAt: new Date(),
            nextRunAt: new Date(),
            lastError: message,
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "failed",
              message,
            }),
          },
        })

        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
          type: "object_transfer",
          skipped: "operation_disabled_for_plan",
        })
      }

      const destinationContextChanged =
        transferPayload.sourceCredentialId !== transferPayload.destinationCredentialId ||
        transferPayload.sourceBucket !== transferPayload.destinationBucket
      if (destinationContextChanged) {
        const bucketLimitViolation = await getBucketLimitViolation({
          userId: actorUserId,
          credentialId: transferPayload.destinationCredentialId,
          bucket: transferPayload.destinationBucket,
          entitlements,
        })
        if (bucketLimitViolation) {
          await prisma.backgroundTask.update({
            where: { id: candidate.id },
            data: {
              status: "failed",
              attempts: candidate.attempts + 1,
              completedAt: new Date(),
              nextRunAt: new Date(),
              lastError: "Bucket limit reached for current plan",
              executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
                status: "failed",
                message: "Bucket limit reached for current plan",
              }),
            },
          })

          return NextResponse.json({
            processed: true,
            taskId: candidate.id,
            done: true,
            type: "object_transfer",
            skipped: "bucket_limit_reached",
            details: bucketLimitViolation,
          })
        }
      }

      const progress = parseObjectTransferProgress(candidate.progress)
      const sourceKeyFilter: { startsWith?: string; gt?: string } = {}
      if (transferPayload.scope === "folder" && transferPayload.sourcePrefix) {
        sourceKeyFilter.startsWith = transferPayload.sourcePrefix
      }
      if (progress.cursorKey) {
        sourceKeyFilter.gt = progress.cursorKey
      }

      const sourceBatch = await prisma.fileMetadata.findMany({
        where: {
          userId: actorUserId,
          credentialId: transferPayload.sourceCredentialId,
          bucket: transferPayload.sourceBucket,
          isFolder: false,
          ...(Object.keys(sourceKeyFilter).length > 0 ? { key: sourceKeyFilter } : {}),
        },
        orderBy: { key: "asc" },
        take: getTaskTransferChunkSize(),
        select: {
          id: true,
          key: true,
          extension: true,
          size: true,
          lastModified: true,
        },
      })

      if (sourceBatch.length === 0) {
        const total = progress.total > 0 ? progress.total : progress.processed
        let syncCleanupDeleted = 0
        let syncCleanupFailed = 0

        if (transferPayload.operation === "sync") {
          const { client: destinationClient } = await getS3Client(
            actorUserId,
            transferPayload.destinationCredentialId
          )
          const cleanupResult = await cleanupSyncDestinationDrift({
            userId: actorUserId,
            payload: transferPayload,
            destinationClient,
          })
          syncCleanupDeleted = cleanupResult.deleted
          syncCleanupFailed = cleanupResult.failed
        }

        await rebuildUserExtensionStats(actorUserId)

        const cycleProgress = {
          total,
          processed: progress.processed,
          copied: progress.copied,
          moved: progress.moved,
          deleted: progress.deleted + syncCleanupDeleted,
          skipped: progress.skipped,
          failed: progress.failed + syncCleanupFailed,
        }

        if (claimedTaskSchedule?.enabled) {
          const nextRunAt =
            nextRunAtForTaskSchedule(claimedTaskSchedule, new Date()) ??
            new Date(Date.now() + SYNC_POLL_INTERVAL_SECONDS * 1000)
          await prisma.backgroundTask.update({
            where: { id: candidate.id },
            data: {
              status: "pending",
              attempts: 0,
              completedAt: null,
              nextRunAt,
              lastRunAt: new Date(),
              progress: {
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
              } as Prisma.InputJsonObject,
              lastError: null,
              executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
                status: cycleProgress.failed > 0 ? "failed" : "succeeded",
                message:
                  cycleProgress.failed > 0
                    ? "Scheduled cycle completed with failures"
                    : "Scheduled cycle completed",
                metadata: {
                  nextRunAt: nextRunAt.toISOString(),
                  schedule: claimedTaskSchedule.cron ?? claimedTaskSchedule.legacyIntervalSeconds,
                  progress: cycleProgress,
                },
              }),
            },
          })

          await logUserAuditAction({
            userId: actorUserId,
            eventType: "s3_action",
            eventName: "object_transfer_scheduled_cycle_completed",
            path: "/api/tasks/process",
            method: "POST",
            target: `${transferPayload.sourceBucket} -> ${transferPayload.destinationBucket}`,
            metadata: {
              scope: transferPayload.scope,
              operation: transferPayload.operation,
              sourceCredentialId: transferPayload.sourceCredentialId,
              sourceBucket: transferPayload.sourceBucket,
              sourcePrefix: transferPayload.sourcePrefix,
              destinationCredentialId: transferPayload.destinationCredentialId,
              destinationBucket: transferPayload.destinationBucket,
              destinationPrefix: transferPayload.destinationPrefix,
              nextRunAt: nextRunAt.toISOString(),
              schedule: claimedTaskSchedule.cron ?? claimedTaskSchedule.legacyIntervalSeconds,
              progress: cycleProgress,
              cleanupDeleted: syncCleanupDeleted,
              cleanupFailed: syncCleanupFailed,
            },
          })

          return NextResponse.json({
            processed: true,
            taskId: candidate.id,
            done: false,
            type: "object_transfer",
            recurring: true,
            nextRunAt: nextRunAt.toISOString(),
            deletedInCleanup: syncCleanupDeleted,
            failedInCleanup: syncCleanupFailed,
          })
        }

        const hasTransferFailures = cycleProgress.failed > 0

        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: hasTransferFailures ? "failed" : "completed",
            attempts: 0,
            completedAt: new Date(),
            nextRunAt: new Date(),
            progress: {
              ...cycleProgress,
              total,
              remaining: 0,
            } as Prisma.InputJsonObject,
            lastError: hasTransferFailures
              ? candidate.lastError ?? "One or more objects failed during transfer"
              : null,
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: hasTransferFailures ? "failed" : "succeeded",
              message: hasTransferFailures
                ? "Transfer completed with failures"
                : "Transfer completed",
              metadata: {
                total,
                processed: cycleProgress.processed,
                copied: cycleProgress.copied,
                moved: cycleProgress.moved,
                deleted: cycleProgress.deleted,
                skipped: cycleProgress.skipped,
                failed: cycleProgress.failed,
              },
            }),
          },
        })

        await logUserAuditAction({
          userId: actorUserId,
          eventType: "s3_action",
          eventName: hasTransferFailures
            ? "object_transfer_failed"
            : "object_transfer_completed",
          path: "/api/tasks/process",
          method: "POST",
          target: `${transferPayload.sourceBucket} -> ${transferPayload.destinationBucket}`,
          metadata: {
            scope: transferPayload.scope,
            operation: transferPayload.operation,
            sourceCredentialId: transferPayload.sourceCredentialId,
            sourceBucket: transferPayload.sourceBucket,
            sourcePrefix: transferPayload.sourcePrefix,
            destinationCredentialId: transferPayload.destinationCredentialId,
            destinationBucket: transferPayload.destinationBucket,
            destinationPrefix: transferPayload.destinationPrefix,
            progress: {
              total,
              processed: progress.processed,
              copied: progress.copied,
              moved: progress.moved,
              deleted: progress.deleted,
              skipped: progress.skipped,
              failed: progress.failed,
            },
          },
        })

        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
          type: "object_transfer",
          failed: hasTransferFailures,
        })
      }

      const [{ client: sourceClient }, { client: destinationClient }] = await Promise.all([
        getS3Client(actorUserId, transferPayload.sourceCredentialId),
        getS3Client(actorUserId, transferPayload.destinationCredentialId),
      ])

      const sameCredential =
        transferPayload.sourceCredentialId === transferPayload.destinationCredentialId
      const requiresDestinationComparison =
        transferPayload.operation === "copy" || transferPayload.operation === "sync"
      const mappedBatch = sourceBatch.map((sourceFile) => ({
        sourceFile,
        destinationKey: mapTransferDestinationKey(
          transferPayload as ObjectTransferTaskPayload,
          sourceFile.key
        ),
      }))

      let destinationByKey = new Map<string, { size: bigint; lastModified: Date }>()
      if (requiresDestinationComparison) {
        const destinationRows = await prisma.fileMetadata.findMany({
          where: {
            userId: actorUserId,
            credentialId: transferPayload.destinationCredentialId,
            bucket: transferPayload.destinationBucket,
            isFolder: false,
            key: { in: mappedBatch.map((item) => item.destinationKey) },
          },
          select: {
            key: true,
            size: true,
            lastModified: true,
          },
        })

        destinationByKey = new Map(
          destinationRows.map((row) => [
            row.key,
            {
              size: row.size,
              lastModified: row.lastModified,
            },
          ])
        )
      }

      let remainingCacheSlots: number | null = null
      if (
        transferPayload.operation === "copy" ||
        transferPayload.operation === "sync"
      ) {
        if (Number.isFinite(entitlements.fileLimit)) {
          const currentCachedFileCount = await prisma.fileMetadata.count({
            where: {
              userId: actorUserId,
              isFolder: false,
            },
          })
          remainingCacheSlots = Math.max(0, entitlements.fileLimit - currentCachedFileCount)
        }
      }

      let copiedInBatch = 0
      let movedInBatch = 0
      let deletedInBatch = 0
      let skippedInBatch = 0
      let failedInBatch = 0
      let processedInBatch = 0
      let lastProcessedCursorKey = progress.cursorKey
      let timeBudgetReached = false
      let batchLastError: string | null = null
      const movedSourceKeys: string[] = []
      const batchStartedAt = Date.now()

      for (const { sourceFile, destinationKey } of mappedBatch) {
        // Keep each processing run bounded so long transfers continue across calls
        // instead of hitting function/request time limits.
        if (
          processedInBatch > 0 &&
          Date.now() - batchStartedAt >= getTaskWorkerUserBudgetMs("object_transfer")
        ) {
          timeBudgetReached = true
          break
        }

        if (
          sameCredential &&
          transferPayload.sourceBucket === transferPayload.destinationBucket &&
          sourceFile.key === destinationKey
        ) {
          skippedInBatch++
          processedInBatch++
          lastProcessedCursorKey = sourceFile.key
          continue
        }

        let destinationExisting = requiresDestinationComparison
          ? destinationByKey.get(destinationKey)
          : undefined
        let destinationExistsRemotely = false

        if (requiresDestinationComparison && !destinationExisting) {
          try {
            const remoteSnapshot = await readRemoteObjectSnapshot({
              client: destinationClient,
              bucket: transferPayload.destinationBucket,
              key: destinationKey,
            })
            if (remoteSnapshot) {
              destinationExistsRemotely = true
              if (remoteSnapshot.size !== null && remoteSnapshot.lastModified) {
                destinationExisting = {
                  size: remoteSnapshot.size,
                  lastModified: remoteSnapshot.lastModified,
                }
                destinationByKey.set(destinationKey, destinationExisting)
              }
            }
          } catch {
            // If destination verification fails, continue with normal transfer flow.
          }
        }

        const createsNewDestination = !destinationExisting && !destinationExistsRemotely

        if (createsNewDestination && remainingCacheSlots !== null && remainingCacheSlots <= 0) {
          skippedInBatch++
          processedInBatch++
          lastProcessedCursorKey = sourceFile.key
          continue
        }

        if (
          transferPayload.operation === "copy" &&
          (destinationExisting || destinationExistsRemotely)
        ) {
          skippedInBatch++
          processedInBatch++
          lastProcessedCursorKey = sourceFile.key
          continue
        }

        if (
          transferPayload.operation === "sync" &&
          destinationExisting &&
          isDestinationUpToDateForSync(
            {
              size: sourceFile.size,
              lastModified: sourceFile.lastModified,
            },
            destinationExisting
          )
        ) {
          skippedInBatch++
          processedInBatch++
          lastProcessedCursorKey = sourceFile.key
          continue
        }

        try {
          await copyObjectAcrossLocations({
            sourceClient,
            destinationClient,
            sameCredential,
            sourceBucket: transferPayload.sourceBucket,
            sourceKey: sourceFile.key,
            destinationBucket: transferPayload.destinationBucket,
            destinationKey,
            expectedContentLength: sourceFile.size,
          })

          await prisma.fileMetadata.upsert({
            where: {
              credentialId_bucket_key: {
                credentialId: transferPayload.destinationCredentialId,
                bucket: transferPayload.destinationBucket,
                key: destinationKey,
              },
            },
            create: {
              userId: actorUserId,
              credentialId: transferPayload.destinationCredentialId,
              bucket: transferPayload.destinationBucket,
              key: destinationKey,
              extension: sourceFile.extension,
              size: sourceFile.size,
              lastModified: sourceFile.lastModified,
              isFolder: false,
            },
            update: {
              extension: sourceFile.extension,
              size: sourceFile.size,
              lastModified: sourceFile.lastModified,
              isFolder: false,
            },
          })
          if (createsNewDestination && remainingCacheSlots !== null) {
            remainingCacheSlots = Math.max(0, remainingCacheSlots - 1)
          }

          if (
            transferPayload.operation === "move" ||
            transferPayload.operation === "migrate"
          ) {
            await sourceClient.send(
              new DeleteObjectCommand({
                Bucket: transferPayload.sourceBucket,
                Key: sourceFile.key,
              })
            )

            await prisma.fileMetadata.deleteMany({
              where: {
                id: sourceFile.id,
                userId: actorUserId,
              },
            })

            movedSourceKeys.push(sourceFile.key)
            movedInBatch++
            deletedInBatch++
          } else {
            copiedInBatch++
          }

          processedInBatch++
          lastProcessedCursorKey = sourceFile.key
        } catch (itemError) {
          const errorCode = getS3ErrorCode(itemError)
          const errorMessage = formatTaskProcessingError(itemError)
          if (!batchLastError) {
            batchLastError = errorMessage
          }

          if (errorCode === "NoSuchKey") {
            // Cache can be stale relative to object storage. Remove missing source entries
            // so retries don't get stuck on the same missing object forever.
            await prisma.fileMetadata.deleteMany({
              where: {
                id: sourceFile.id,
                userId: actorUserId,
              },
            })
            await deleteMediaThumbnailsForKeys({
              userId: actorUserId,
              credentialId: transferPayload.sourceCredentialId,
              bucket: transferPayload.sourceBucket,
              keys: [sourceFile.key],
            })
            skippedInBatch++
          } else {
            failedInBatch++
          }

          processedInBatch++
          lastProcessedCursorKey = sourceFile.key
        }
      }

      if (movedSourceKeys.length > 0) {
        await deleteMediaThumbnailsForKeys({
          userId: actorUserId,
          credentialId: transferPayload.sourceCredentialId,
          bucket: transferPayload.sourceBucket,
          keys: movedSourceKeys,
        })
      }

      const total = progress.total > 0 ? progress.total : sourceBatch.length
      const nextProcessed = progress.processed + processedInBatch
      const nextProgress: ObjectTransferTaskProgress = {
        phase: "transfer",
        total,
        processed: nextProcessed,
        copied: progress.copied + copiedInBatch,
        moved: progress.moved + movedInBatch,
        deleted: progress.deleted + deletedInBatch,
        skipped: progress.skipped + skippedInBatch,
        failed: progress.failed + failedInBatch,
        remaining: Math.max(0, total - nextProcessed),
        cursorKey: lastProcessedCursorKey,
      }

      await prisma.backgroundTask.update({
        where: { id: candidate.id },
        data: {
          status: "in_progress",
          attempts: 0,
          nextRunAt: new Date(),
          progress: nextProgress as unknown as Prisma.InputJsonObject,
          lastError:
            batchLastError ??
            (nextProgress.failed > 0
              ? candidate.lastError ?? "One or more objects failed during transfer"
              : null),
          completedAt: null,
        },
      })

      return NextResponse.json({
        processed: true,
        taskId: candidate.id,
        done: false,
        type: "object_transfer",
        processedInBatch,
        copiedInBatch,
        movedInBatch,
        skippedInBatch,
        failedInBatch,
        timeBudgetReached,
      })
    }

    const bulkPlanPayload = resolveTaskPlanPayload(candidate.executionPlan, candidate.payload)
    const payload = parsePayload(bulkPlanPayload)
    if (!payload) {
      const nextAttempts = candidate.attempts + 1
      await prisma.backgroundTask.update({
        where: { id: candidate.id },
        data: {
          status: "failed",
          attempts: nextAttempts,
          lastError: "Invalid task payload",
          completedAt: new Date(),
          nextRunAt: new Date(),
          executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
            status: "failed",
            message: "Invalid task payload",
          }),
        },
      })
      return NextResponse.json({ processed: false, message: "Invalid task payload" })
    }

    const searchEntitlements = await getUserPlanEntitlements(actorUserId)
    if (!searchEntitlements?.searchAllFiles) {
      await prisma.backgroundTask.update({
        where: { id: candidate.id },
        data: {
          status: "failed",
          attempts: candidate.attempts + 1,
          lastError: "Bulk delete via search is disabled for the current plan",
          completedAt: new Date(),
          nextRunAt: new Date(),
          executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
            status: "failed",
            message: "Bulk delete via search is disabled for the current plan",
          }),
        },
      })
      return NextResponse.json({
        processed: true,
        taskId: candidate.id,
        done: true,
        type: "bulk_delete",
        skipped: "search_disabled_for_plan",
      })
    }

    const whereClause = buildFileSearchSqlWhereClause({
      userId: actorUserId,
      query: payload.query,
      credentialIds: payload.selectedCredentialIds,
      scopes: parseScopes(payload.selectedBucketScopes),
      type: payload.selectedType,
    })
    const progress = parseProgress(candidate.progress)

    const batch = await prisma.$queryRaw<Array<{
      id: string
      key: string
      bucket: string
      credentialId: string
    }>>(Prisma.sql`
      SELECT
        fm."id",
        fm."key",
        fm."bucket",
        fm."credentialId"
      FROM "FileMetadata" fm
      WHERE ${whereClause}
      ${progress.cursorId ? Prisma.sql`AND fm."id" > ${progress.cursorId}` : Prisma.empty}
      ORDER BY fm."id" ASC
      LIMIT ${CHUNK_SIZE}
    `)

    if (batch.length === 0) {
      await rebuildUserExtensionStats(actorUserId)

      if (claimedTaskSchedule?.enabled) {
        const nextRunAt =
          nextRunAtForTaskSchedule(claimedTaskSchedule, new Date()) ??
          new Date(Date.now() + SYNC_POLL_INTERVAL_SECONDS * 1000)
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "pending",
            attempts: 0,
            completedAt: null,
            nextRunAt,
            progress: {
              total: 0,
              deleted: 0,
              remaining: 0,
              cursorId: null,
            },
            lastError: null,
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "succeeded",
              message: "Scheduled bulk delete cycle completed",
              metadata: {
                deleted: progress.total,
                nextRunAt: nextRunAt.toISOString(),
                schedule: claimedTaskSchedule.cron ?? claimedTaskSchedule.legacyIntervalSeconds,
              },
            }),
          },
        })

        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: false,
          recurring: true,
          nextRunAt: nextRunAt.toISOString(),
        })
      }

      await prisma.backgroundTask.update({
        where: { id: candidate.id },
        data: {
          status: "completed",
          attempts: 0,
          completedAt: new Date(),
          nextRunAt: new Date(),
          progress: {
            total: progress.total,
            deleted: progress.total,
            remaining: 0,
            cursorId: null,
          },
          lastError: null,
          executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
            status: "succeeded",
            message: "Bulk delete completed",
            metadata: {
              deleted: progress.total,
            },
          }),
        },
      })

      return NextResponse.json({ processed: true, taskId: candidate.id, done: true })
    }

    const grouped = new Map<string, { bucket: string; credentialId: string; rows: typeof batch }>()

    for (const row of batch) {
      const groupKey = `${row.credentialId}::${row.bucket}`
      const existing = grouped.get(groupKey)
      if (existing) {
        existing.rows.push(row)
      } else {
        grouped.set(groupKey, {
          bucket: row.bucket,
          credentialId: row.credentialId,
          rows: [row],
        })
      }
    }

    const clients = new Map<string, InstanceType<typeof import("@aws-sdk/client-s3").S3Client>>()
    const deletedIds = new Set<string>()

    for (const group of grouped.values()) {
      let client = clients.get(group.credentialId)
      if (!client) {
        const response = await getS3Client(actorUserId, group.credentialId)
        client = response.client
        clients.set(group.credentialId, client)
      }

      const keys = group.rows.map((row) => row.key)
      const deletedKeys = await deleteKeysFromBucket(client, group.bucket, keys)
      if (deletedKeys.size > 0) {
        await deleteMediaThumbnailsForKeys({
          userId: actorUserId,
          credentialId: group.credentialId,
          bucket: group.bucket,
          keys: Array.from(deletedKeys),
        })
      }

      for (const row of group.rows) {
        if (deletedKeys.has(row.key)) {
          deletedIds.add(row.id)
        }
      }
    }

    if (deletedIds.size === 0) {
      throw new Error("No files could be deleted in this batch")
    }

    await prisma.fileMetadata.deleteMany({
      where: {
        id: {
          in: Array.from(deletedIds),
        },
      },
    })

    await rebuildUserExtensionStats(actorUserId)

    const [remainingResult] = await prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "total"
      FROM "FileMetadata" fm
      WHERE ${whereClause}
    `)
    const remaining = Number(remainingResult?.total ?? 0)
    const total = progress.total > 0 ? progress.total : remaining + deletedIds.size
    const deleted = Math.max(0, total - remaining)
    let lastBatchCursorId = progress.cursorId
    let cursorBlocked = false
    for (const row of batch) {
      if (!cursorBlocked && deletedIds.has(row.id)) {
        lastBatchCursorId = row.id
      } else {
        cursorBlocked = true
      }
    }

    if (remaining === 0 && claimedTaskSchedule?.enabled) {
      const nextRunAt =
        nextRunAtForTaskSchedule(claimedTaskSchedule, new Date()) ??
        new Date(Date.now() + SYNC_POLL_INTERVAL_SECONDS * 1000)
      await prisma.backgroundTask.update({
        where: { id: candidate.id },
        data: {
          status: "pending",
          attempts: 0,
          completedAt: null,
          nextRunAt,
          progress: {
            total: 0,
            deleted: 0,
            remaining: 0,
            cursorId: null,
          },
          lastError: null,
          executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
            status: "succeeded",
            message: "Scheduled bulk delete cycle completed",
            metadata: {
              total,
              deleted,
              nextRunAt: nextRunAt.toISOString(),
              schedule: claimedTaskSchedule.cron ?? claimedTaskSchedule.legacyIntervalSeconds,
            },
          }),
        },
      })

      return NextResponse.json({
        processed: true,
        taskId: candidate.id,
        deletedInBatch: deletedIds.size,
        done: false,
        recurring: true,
        nextRunAt: nextRunAt.toISOString(),
      })
    }

    await prisma.backgroundTask.update({
      where: { id: candidate.id },
      data: {
        status: remaining === 0 ? "completed" : "in_progress",
        attempts: 0,
        completedAt: remaining === 0 ? new Date() : null,
        nextRunAt: new Date(),
        progress: {
          total,
          deleted,
          remaining,
          cursorId: remaining === 0 ? null : lastBatchCursorId,
        },
        lastError: null,
        ...(remaining === 0
          ? {
              executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
                status: "succeeded",
                message: "Bulk delete completed",
                metadata: {
                  total,
                  deleted,
                },
              }),
            }
          : {}),
      },
    })

    return NextResponse.json({
      processed: true,
      taskId: candidate.id,
      deletedInBatch: deletedIds.size,
      done: remaining === 0,
    })
  } catch (error) {
    console.error("Failed to process task:", error)

    const message = formatTaskProcessingError(error)
    const taskAttemptFailed = Boolean(userId && claimedTask)

    try {
      if (userId && claimedTask) {
        const now = new Date()
        const nextAttempts = claimedTask.attempts + 1
        const retryable = nextAttempts < claimedTask.maxAttempts
        const backoffSeconds = Math.min(300, Math.pow(2, nextAttempts))
        const nextScheduledRunAt =
          claimedTaskSchedule?.enabled
            ? nextRunAtForTaskSchedule(claimedTaskSchedule, now) ??
              new Date(now.getTime() + SYNC_POLL_INTERVAL_SECONDS * 1000)
            : null

        if (claimedTask.type === "thumbnail_generate" && thumbnailPayload) {
          await prisma.mediaThumbnail.updateMany({
            where: {
              userId,
              credentialId: thumbnailPayload.credentialId,
              bucket: thumbnailPayload.bucket,
              key: thumbnailPayload.key,
            },
            data: {
              status: "failed",
              lastError: message,
            },
          })

          await logUserAuditAction({
            userId,
            eventType: "s3_action",
            eventName: "thumbnail_generate_failed",
            path: "/api/tasks/process",
            method: "POST",
            target: thumbnailPayload.key,
            metadata: {
              bucket: thumbnailPayload.bucket,
              credentialId: thumbnailPayload.credentialId,
              error: message,
            },
          })
        }

        if (claimedTask.type === "object_transfer" && transferPayload) {
          await logUserAuditAction({
            userId,
            eventType: "s3_action",
            eventName: "object_transfer_failed",
            path: "/api/tasks/process",
            method: "POST",
            target: `${transferPayload.sourceBucket} -> ${transferPayload.destinationBucket}`,
            metadata: {
              scope: transferPayload.scope,
              operation: transferPayload.operation,
              sourceCredentialId: transferPayload.sourceCredentialId,
              sourceBucket: transferPayload.sourceBucket,
              sourcePrefix: transferPayload.sourcePrefix,
              destinationCredentialId: transferPayload.destinationCredentialId,
              destinationBucket: transferPayload.destinationBucket,
              destinationPrefix: transferPayload.destinationPrefix,
              error: message,
            },
          })
        }

        const failureUpdate: Prisma.BackgroundTaskUpdateManyMutationInput = (() => {
          if (claimedTaskSchedule?.enabled && !retryable) {
            return {
              attempts: 0,
              status: "pending",
              nextRunAt: nextScheduledRunAt ?? new Date(now.getTime() + backoffSeconds * 1000),
              lastError: message,
              completedAt: null,
              executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
                status: "failed",
                message: "Scheduled run failed",
                metadata: {
                  error: message,
                  nextRunAt: nextScheduledRunAt?.toISOString() ?? null,
                },
              }),
            }
          }

          const base: Prisma.BackgroundTaskUpdateManyMutationInput = {
            attempts: nextAttempts,
            status: retryable ? "pending" : "failed",
            nextRunAt: retryable
              ? new Date(now.getTime() + backoffSeconds * 1000)
              : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
            lastError: message,
            completedAt: retryable ? null : now,
          }
          if (!retryable) {
            base.executionHistory = addTaskHistoryEntry(taskExecutionHistory, {
              status: "failed",
              message,
            })
          }
          return base
        })()

        await prisma.backgroundTask.updateMany({
          where: {
            id: claimedTask.id,
            userId,
            type: claimedTask.type,
            status: "in_progress",
          },
          data: failureUpdate,
        })
      }
    } catch (updateError) {
      console.error("Failed to update task failure state:", updateError)
    }

    // A task-level failure was already persisted (retry scheduled or failed state set).
    // Return 200 to avoid noisy client-side 500s while the queue keeps progressing.
    if (taskAttemptFailed && claimedTask) {
      const retryable = claimedTask.attempts + 1 < claimedTask.maxAttempts
      return NextResponse.json({
        processed: true,
        taskId: claimedTask.id,
        done: false,
        error: message,
        retryable,
      })
    }

    return NextResponse.json({ processed: false, error: message }, { status: 500 })
  }
}
