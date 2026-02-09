import { prisma } from "@/lib/db"
import type { Prisma } from "@prisma/client"
import { buildThumbnailObjectKey, copyThumbnailObject, deleteThumbnailObjects, getThumbnailBucketName } from "@/lib/thumbnail-storage"

export interface ThumbnailTaskPayload {
  bucket: string
  key: string
  credentialId: string
}

function thumbnailTaskTitle(key: string) {
  const name = key.split("/").pop() || key
  return `Generate thumbnail: ${name}`
}

export async function queueThumbnailTasks(userId: string, tasks: ThumbnailTaskPayload[]) {
  const deduped = new Map<string, ThumbnailTaskPayload>()
  for (const task of tasks) {
    const dedupeKey = `${task.credentialId}::${task.bucket}::${task.key}`
    deduped.set(dedupeKey, task)
  }

  const payloads = Array.from(deduped.values())
  if (payloads.length === 0) return 0

  await prisma.backgroundTask.createMany({
    data: payloads.map((task) => ({
      userId,
      type: "thumbnail_generate",
      title: thumbnailTaskTitle(task.key),
      status: "pending",
      payload: {
        bucket: task.bucket,
        key: task.key,
        credentialId: task.credentialId,
      } as Prisma.InputJsonObject,
      nextRunAt: new Date(),
    })),
  })

  return payloads.length
}

export async function deleteMediaThumbnailsForKeys(params: {
  userId: string
  credentialId: string
  bucket: string
  keys: string[]
}) {
  if (params.keys.length === 0) {
    return { deletedRows: 0, deletedObjects: 0 }
  }

  const rows = await prisma.mediaThumbnail.findMany({
    where: {
      userId: params.userId,
      credentialId: params.credentialId,
      bucket: params.bucket,
      key: { in: params.keys },
    },
    select: {
      id: true,
      thumbnailKey: true,
    },
  })

  if (rows.length === 0) {
    return { deletedRows: 0, deletedObjects: 0 }
  }

  const thumbnailKeys = Array.from(
    new Set(rows.map((row) => row.thumbnailKey).filter((value): value is string => Boolean(value)))
  )
  let deletedObjects = 0
  try {
    await deleteThumbnailObjects(thumbnailKeys)
    deletedObjects = thumbnailKeys.length
  } catch {
    deletedObjects = 0
  }

  await prisma.mediaThumbnail.deleteMany({
    where: {
      id: { in: rows.map((row) => row.id) },
    },
  })

  return { deletedRows: rows.length, deletedObjects }
}

export async function purgeMediaThumbnailsForUser(params: { userId: string }) {
  const rows = await prisma.mediaThumbnail.findMany({
    where: {
      userId: params.userId,
    },
    select: {
      id: true,
      thumbnailKey: true,
    },
  })

  const thumbnailKeys = Array.from(
    new Set(rows.map((row) => row.thumbnailKey).filter((value): value is string => Boolean(value)))
  )

  let deletedObjects = 0
  if (thumbnailKeys.length > 0) {
    try {
      await deleteThumbnailObjects(thumbnailKeys)
      deletedObjects = thumbnailKeys.length
    } catch {
      deletedObjects = 0
    }
  }

  const deletedRows = await prisma.mediaThumbnail.deleteMany({
    where: {
      userId: params.userId,
    },
  })

  const deletedTasks = await prisma.backgroundTask.deleteMany({
    where: {
      userId: params.userId,
      type: "thumbnail_generate",
      status: "pending",
    },
  })

  return {
    deletedRows: deletedRows.count,
    deletedObjects,
    deletedTasks: deletedTasks.count,
  }
}

export async function moveMediaThumbnailForObject(params: {
  userId: string
  credentialId: string
  fromBucket: string
  fromKey: string
  toBucket: string
  toKey: string
  sourceLastModified: Date
  sourceSize: bigint
}) {
  const existing = await prisma.mediaThumbnail.findUnique({
    where: {
      userId_credentialId_bucket_key: {
        userId: params.userId,
        credentialId: params.credentialId,
        bucket: params.fromBucket,
        key: params.fromKey,
      },
    },
  })

  if (!existing) return { moved: false, queued: false }

  const sourceLastModified = existing.sourceLastModified ?? params.sourceLastModified
  const sourceSize = existing.sourceSize ?? params.sourceSize

  const nextThumbnailKey = buildThumbnailObjectKey({
    userId: params.userId,
    credentialId: params.credentialId,
    bucket: params.toBucket,
    key: params.toKey,
    sourceLastModified,
    sourceSize,
  })

  let thumbnailBucket: string | null = null
  try {
    thumbnailBucket = getThumbnailBucketName()
  } catch {
    thumbnailBucket = null
  }

  const updateBase = {
    bucket: params.toBucket,
    key: params.toKey,
    sourceLastModified,
    sourceSize,
    thumbnailBucket,
  }

  if (!existing.thumbnailKey) {
    await prisma.mediaThumbnail.update({
      where: { id: existing.id },
      data: {
        ...updateBase,
        status: "pending",
        thumbnailKey: nextThumbnailKey,
        lastError: "Thumbnail missing; requeued after move",
      },
    })
    await queueThumbnailTasks(params.userId, [
      {
        credentialId: params.credentialId,
        bucket: params.toBucket,
        key: params.toKey,
      },
    ])
    return { moved: false, queued: true }
  }

  try {
    await copyThumbnailObject(existing.thumbnailKey, nextThumbnailKey)
    await deleteThumbnailObjects([existing.thumbnailKey])

    await prisma.mediaThumbnail.update({
      where: { id: existing.id },
      data: {
        ...updateBase,
        status: "ready",
        thumbnailKey: nextThumbnailKey,
        mimeType: existing.mimeType ?? "image/webp",
        lastError: null,
      },
    })

    return { moved: true, queued: false }
  } catch (error) {
    await prisma.mediaThumbnail.update({
      where: { id: existing.id },
      data: {
        ...updateBase,
        status: "pending",
        thumbnailKey: nextThumbnailKey,
        lastError: error instanceof Error ? error.message : "thumbnail_move_failed",
      },
    })

    await queueThumbnailTasks(params.userId, [
      {
        credentialId: params.credentialId,
        bucket: params.toBucket,
        key: params.toKey,
      },
    ])
    return { moved: false, queued: true }
  }
}
