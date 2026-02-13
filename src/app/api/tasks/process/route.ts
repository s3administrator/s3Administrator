import { NextResponse } from "next/server"
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
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
import { generateVideoThumbnail } from "@/lib/thumbnail-worker"
import {
  buildThumbnailObjectKey,
  getThumbnailBucketName,
  getThumbnailMaxWidth,
  uploadThumbnailObject,
} from "@/lib/thumbnail-storage"
import { deleteMediaThumbnailsForKeys } from "@/lib/media-thumbnails"
import { isThumbnailCacheEnabledForUser } from "@/lib/thumbnail-cache-policy"
import {
  getObjectTransferDisabledMessage,
} from "@/lib/transfer-task-policy"
import { logUserAuditAction } from "@/lib/audit-logger"

const CHUNK_SIZE = 500
const TRANSFER_CHUNK_SIZE = 100
const LOCK_SECONDS = 20
const THUMBNAIL_TIMEOUT_MS = 5_000
const SYNC_POLL_INTERVAL_SECONDS = 60

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
    }
  }

  const progress = raw as {
    total?: unknown
    deleted?: unknown
    remaining?: unknown
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

function getSyncPollIntervalMs(payload: ObjectTransferTaskPayload): number {
  const seconds =
    payload.pollIntervalSeconds && payload.pollIntervalSeconds >= SYNC_POLL_INTERVAL_SECONDS
      ? payload.pollIntervalSeconds
      : SYNC_POLL_INTERVAL_SECONDS
  return seconds * 1000
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

async function copyObjectAcrossLocations(params: {
  sourceClient: S3Client
  destinationClient: S3Client
  sameCredential: boolean
  sourceBucket: string
  sourceKey: string
  destinationBucket: string
  destinationKey: string
}) {
  if (params.sameCredential) {
    await params.destinationClient.send(
      new CopyObjectCommand({
        Bucket: params.destinationBucket,
        CopySource: encodeURIComponent(`${params.sourceBucket}/${params.sourceKey}`),
        Key: params.destinationKey,
      })
    )
    return
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

  await params.destinationClient.send(
    new PutObjectCommand({
      Bucket: params.destinationBucket,
      Key: params.destinationKey,
      Body: sourceObject.Body,
      ContentType: sourceObject.ContentType,
      CacheControl: sourceObject.CacheControl,
    })
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
}): Promise<SyncDestinationDriftRow[]> {
  const { userId, payload } = params

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
      LIMIT ${TRANSFER_CHUNK_SIZE}
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
    LIMIT ${TRANSFER_CHUNK_SIZE}
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
    const driftRows = await findSyncDestinationDriftBatch({ userId, payload })
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

export async function POST() {
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

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const now = new Date()
    const lockedTask = await prisma.backgroundTask.findFirst({
      where: {
        userId: session.user.id,
        status: "in_progress",
        nextRunAt: {
          gt: now,
        },
      },
      select: { id: true },
    })

    if (lockedTask) {
      return NextResponse.json({
        processed: false,
        message: "Another task is currently locked for processing",
      })
    }

    const candidate = await prisma.backgroundTask.findFirst({
      where: {
        userId: session.user.id,
        type: {
          in: ["bulk_delete", "thumbnail_generate", "object_transfer"],
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

    if (!candidate) {
      return NextResponse.json({ processed: false, message: "No pending tasks" })
    }

    const lockUntil = new Date(Date.now() + LOCK_SECONDS * 1000)
    const claimed = await prisma.backgroundTask.updateMany({
      where: {
        id: candidate.id,
        userId: session.user.id,
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

    if (candidate.type === "thumbnail_generate") {
      thumbnailPayload = parseThumbnailPayload(candidate.payload)
      if (!thumbnailPayload) {
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "failed",
            attempts: candidate.attempts + 1,
            lastError: "Invalid thumbnail payload",
            completedAt: new Date(),
            nextRunAt: new Date(),
          },
        })
        return NextResponse.json({ processed: false, message: "Invalid thumbnail payload" })
      }

      const thumbnailCacheEnabled = await isThumbnailCacheEnabledForUser(session.user.id)
      if (!thumbnailCacheEnabled) {
        await deleteMediaThumbnailsForKeys({
          userId: session.user.id,
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
          },
        })

        await logUserAuditAction({
          userId: session.user.id,
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

      const { client } = await getS3Client(session.user.id, thumbnailPayload.credentialId)
      const sourceFile = await prisma.fileMetadata.findFirst({
        where: {
          userId: session.user.id,
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
            userId: session.user.id,
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
          },
        })
        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
          skipped: "source_missing",
        })
      }

      if (getMediaTypeFromExtension(sourceFile.extension) !== "video") {
        await prisma.mediaThumbnail.updateMany({
          where: {
            userId: session.user.id,
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
      const thumbnailKey = buildThumbnailObjectKey({
        userId: session.user.id,
        credentialId: thumbnailPayload.credentialId,
        bucket: thumbnailPayload.bucket,
        key: thumbnailPayload.key,
        sourceLastModified,
        sourceSize,
      })
      const thumbnailBucket = getThumbnailBucketName()

      await prisma.mediaThumbnail.upsert({
        where: {
          userId_credentialId_bucket_key: {
            userId: session.user.id,
            credentialId: thumbnailPayload.credentialId,
            bucket: thumbnailPayload.bucket,
            key: thumbnailPayload.key,
          },
        },
        create: {
          userId: session.user.id,
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
      const generated = await generateVideoThumbnail({
        client,
        bucket: thumbnailPayload.bucket,
        key: thumbnailPayload.key,
        maxWidth: getThumbnailMaxWidth(),
        timeoutMs: THUMBNAIL_TIMEOUT_MS,
      })

      const stillEnabled = await isThumbnailCacheEnabledForUser(session.user.id)
      if (!stillEnabled) {
        await deleteMediaThumbnailsForKeys({
          userId: session.user.id,
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
          },
        })

        return NextResponse.json({
          processed: true,
          taskId: candidate.id,
          done: true,
          skipped: "thumbnail_cache_disabled",
        })
      }

      await uploadThumbnailObject({
        key: thumbnailKey,
        body: generated.buffer,
        contentType: generated.mimeType,
      })

      await prisma.mediaThumbnail.update({
        where: {
          userId_credentialId_bucket_key: {
            userId: session.user.id,
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
        },
      })

      await logUserAuditAction({
        userId: session.user.id,
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
      transferPayload = parseObjectTransferPayload(candidate.payload)
      if (!transferPayload) {
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "failed",
            attempts: candidate.attempts + 1,
            lastError: "Invalid object transfer payload",
            completedAt: new Date(),
            nextRunAt: new Date(),
          },
        })
        return NextResponse.json({ processed: false, message: "Invalid object transfer payload" })
      }

      const entitlements = await getUserPlanEntitlements(session.user.id)
      if (!entitlements || !entitlements.transferTasks) {
        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "failed",
            attempts: candidate.attempts + 1,
            completedAt: new Date(),
            nextRunAt: new Date(),
            lastError: getObjectTransferDisabledMessage(),
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
          userId: session.user.id,
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
          userId: session.user.id,
          credentialId: transferPayload.sourceCredentialId,
          bucket: transferPayload.sourceBucket,
          isFolder: false,
          ...(Object.keys(sourceKeyFilter).length > 0 ? { key: sourceKeyFilter } : {}),
        },
        orderBy: { key: "asc" },
        take: TRANSFER_CHUNK_SIZE,
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
            session.user.id,
            transferPayload.destinationCredentialId
          )
          const cleanupResult = await cleanupSyncDestinationDrift({
            userId: session.user.id,
            payload: transferPayload,
            destinationClient,
          })
          syncCleanupDeleted = cleanupResult.deleted
          syncCleanupFailed = cleanupResult.failed
        }

        await rebuildUserExtensionStats(session.user.id)

        if (transferPayload.operation === "sync") {
          const cycleProgress = {
            total,
            processed: progress.processed,
            copied: progress.copied,
            moved: progress.moved,
            deleted: progress.deleted + syncCleanupDeleted,
            skipped: progress.skipped,
            failed: progress.failed + syncCleanupFailed,
          }
          const nextRunAt = new Date(Date.now() + getSyncPollIntervalMs(transferPayload))
          await prisma.backgroundTask.update({
            where: { id: candidate.id },
            data: {
              status: "pending",
              attempts: 0,
              completedAt: null,
              nextRunAt,
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
            },
          })

          await logUserAuditAction({
            userId: session.user.id,
            eventType: "s3_action",
            eventName: "object_transfer_sync_cycle_completed",
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
              intervalSeconds: getSyncPollIntervalMs(transferPayload) / 1000,
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

        await prisma.backgroundTask.update({
          where: { id: candidate.id },
          data: {
            status: "completed",
            attempts: 0,
            completedAt: new Date(),
            nextRunAt: new Date(),
            progress: {
              ...progress,
              total,
              remaining: 0,
            } as Prisma.InputJsonObject,
            lastError: null,
          },
        })

        await logUserAuditAction({
          userId: session.user.id,
          eventType: "s3_action",
          eventName: "object_transfer_completed",
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
        })
      }

      const [{ client: sourceClient }, { client: destinationClient }] = await Promise.all([
        getS3Client(session.user.id, transferPayload.sourceCredentialId),
        getS3Client(session.user.id, transferPayload.destinationCredentialId),
      ])

      const sameCredential =
        transferPayload.sourceCredentialId === transferPayload.destinationCredentialId
      const destinationKeys = sourceBatch.map((file) =>
        mapTransferDestinationKey(transferPayload as ObjectTransferTaskPayload, file.key)
      )

      const destinationRows = await prisma.fileMetadata.findMany({
        where: {
          userId: session.user.id,
          credentialId: transferPayload.destinationCredentialId,
          bucket: transferPayload.destinationBucket,
          isFolder: false,
          key: { in: destinationKeys },
        },
        select: {
          key: true,
          size: true,
          lastModified: true,
        },
      })

      const destinationByKey = new Map(destinationRows.map((row) => [row.key, row]))

      let remainingCacheSlots: number | null = null
      if (
        transferPayload.operation === "copy" ||
        transferPayload.operation === "sync"
      ) {
        if (Number.isFinite(entitlements.fileLimit)) {
          const currentCachedFileCount = await prisma.fileMetadata.count({
            where: {
              userId: session.user.id,
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
      let processedInBatch = 0
      const movedSourceKeys: string[] = []

      for (const sourceFile of sourceBatch) {
        const destinationKey = mapTransferDestinationKey(
          transferPayload as ObjectTransferTaskPayload,
          sourceFile.key
        )

        if (
          sameCredential &&
          transferPayload.sourceBucket === transferPayload.destinationBucket &&
          sourceFile.key === destinationKey
        ) {
          skippedInBatch++
          processedInBatch++
          continue
        }

        const destinationExisting = destinationByKey.get(destinationKey)
        const createsNewDestination = !destinationExisting

        if (createsNewDestination && remainingCacheSlots !== null && remainingCacheSlots <= 0) {
          skippedInBatch++
          processedInBatch++
          continue
        }

        if (transferPayload.operation === "copy" && destinationExisting) {
          skippedInBatch++
          processedInBatch++
          continue
        }

        if (
          transferPayload.operation === "sync" &&
          destinationExisting &&
          destinationExisting.size.toString() === sourceFile.size.toString() &&
          destinationExisting.lastModified.getTime() === sourceFile.lastModified.getTime()
        ) {
          skippedInBatch++
          processedInBatch++
          continue
        }

        await copyObjectAcrossLocations({
          sourceClient,
          destinationClient,
          sameCredential,
          sourceBucket: transferPayload.sourceBucket,
          sourceKey: sourceFile.key,
          destinationBucket: transferPayload.destinationBucket,
          destinationKey,
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
            userId: session.user.id,
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
              userId: session.user.id,
            },
          })

          movedSourceKeys.push(sourceFile.key)
          movedInBatch++
          deletedInBatch++
        } else {
          copiedInBatch++
        }

        processedInBatch++
      }

      if (movedSourceKeys.length > 0) {
        await deleteMediaThumbnailsForKeys({
          userId: session.user.id,
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
        failed: progress.failed,
        remaining: Math.max(0, total - nextProcessed),
        cursorKey: sourceBatch[sourceBatch.length - 1]?.key ?? progress.cursorKey,
      }

      await prisma.backgroundTask.update({
        where: { id: candidate.id },
        data: {
          status: "in_progress",
          attempts: 0,
          nextRunAt: new Date(),
          progress: nextProgress as unknown as Prisma.InputJsonObject,
          lastError: null,
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
      })
    }

    const payload = parsePayload(candidate.payload)
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
        },
      })
      return NextResponse.json({ processed: false, message: "Invalid task payload" })
    }

    const searchEntitlements = await getUserPlanEntitlements(session.user.id)
    if (!searchEntitlements?.searchAllFiles) {
      await prisma.backgroundTask.update({
        where: { id: candidate.id },
        data: {
          status: "failed",
          attempts: candidate.attempts + 1,
          lastError: "Bulk delete via search is disabled for the current plan",
          completedAt: new Date(),
          nextRunAt: new Date(),
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
      userId: session.user.id,
      query: payload.query,
      credentialIds: payload.selectedCredentialIds,
      scopes: parseScopes(payload.selectedBucketScopes),
      type: payload.selectedType,
    })

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
      ORDER BY fm."id" ASC
      LIMIT ${CHUNK_SIZE}
    `)

    const progress = parseProgress(candidate.progress)

    if (batch.length === 0) {
      await rebuildUserExtensionStats(session.user.id)

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
          },
          lastError: null,
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
        const response = await getS3Client(session.user.id, group.credentialId)
        client = response.client
        clients.set(group.credentialId, client)
      }

      const keys = group.rows.map((row) => row.key)
      const deletedKeys = await deleteKeysFromBucket(client, group.bucket, keys)
      if (deletedKeys.size > 0) {
        await deleteMediaThumbnailsForKeys({
          userId: session.user.id,
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

    await rebuildUserExtensionStats(session.user.id)

    const [remainingResult] = await prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "total"
      FROM "FileMetadata" fm
      WHERE ${whereClause}
    `)
    const remaining = Number(remainingResult?.total ?? 0)
    const total = progress.total > 0 ? progress.total : remaining + deletedIds.size
    const deleted = Math.max(0, total - remaining)

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
        },
        lastError: null,
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

    const message = error instanceof Error ? error.message : "Task processing failed"

    try {
      if (userId && claimedTask) {
        const now = new Date()
        const nextAttempts = claimedTask.attempts + 1
        const retryable = nextAttempts < claimedTask.maxAttempts
        const backoffSeconds = Math.min(300, Math.pow(2, nextAttempts))

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

        await prisma.backgroundTask.updateMany({
          where: {
            id: claimedTask.id,
            userId,
            type: claimedTask.type,
            status: "in_progress",
          },
          data: {
            attempts: nextAttempts,
            status: retryable ? "pending" : "failed",
            nextRunAt: retryable
              ? new Date(now.getTime() + backoffSeconds * 1000)
              : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
            lastError: message,
            completedAt: retryable ? null : now,
          },
        })
      }
    } catch (updateError) {
      console.error("Failed to update task failure state:", updateError)
    }

    return NextResponse.json({ processed: false, error: message }, { status: 500 })
  }
}
