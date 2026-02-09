import { NextResponse } from "next/server"
import { DeleteObjectsCommand } from "@aws-sdk/client-s3"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { rebuildUserExtensionStats } from "@/lib/file-stats"
import { buildFileSearchWhereClause, parseScopes } from "@/lib/file-search"
import { getMediaTypeFromExtension } from "@/lib/media"
import { generateVideoThumbnail } from "@/lib/thumbnail-worker"
import {
  buildThumbnailObjectKey,
  getThumbnailBucketName,
  getThumbnailMaxWidth,
  uploadThumbnailObject,
} from "@/lib/thumbnail-storage"
import { deleteMediaThumbnailsForKeys } from "@/lib/media-thumbnails"
import { logUserAuditAction } from "@/lib/audit-logger"

const CHUNK_SIZE = 500
const LOCK_SECONDS = 20
const THUMBNAIL_TIMEOUT_MS = 5_000

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

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const now = new Date()

    const candidate = await prisma.backgroundTask.findFirst({
      where: {
        userId: session.user.id,
        type: {
          in: ["bulk_delete", "thumbnail_generate"],
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

    const whereClause = buildFileSearchWhereClause({
      userId: session.user.id,
      query: payload.query,
      credentialIds: payload.selectedCredentialIds,
      scopes: parseScopes(payload.selectedBucketScopes),
      type: payload.selectedType,
    })

    const batch = await prisma.fileMetadata.findMany({
      where: whereClause,
      select: {
        id: true,
        key: true,
        bucket: true,
        credentialId: true,
      },
      orderBy: {
        id: "asc",
      },
      take: CHUNK_SIZE,
    })

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

    const remaining = await prisma.fileMetadata.count({ where: whereClause })
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
