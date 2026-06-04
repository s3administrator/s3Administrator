import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { prisma } from "@/lib/db"
import { getObjectExtension, rebuildUserExtensionStats } from "@/lib/file-stats"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import { getBucketLimitViolation } from "@/lib/plan-limits"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import { ListObjectsV2Command } from "@aws-sdk/client-s3"

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const body = await request.json()
    const { bucket, credentialId } = body
    auditBucket = bucket

    if (!bucket) {
      return NextResponse.json(
        { error: "bucket is required" },
        { status: 400 }
      )
    }

    const entitlements = await getUserPlanEntitlements(session.user.id)
    if (!entitlements) {
      return NextResponse.json({ error: "Failed to resolve plan entitlements" }, { status: 403 })
    }
    const fileLimit = entitlements.fileLimit
    const storageLimit = entitlements.storageLimitBytes

    const { client, credential } = await getS3Client(session.user.id, credentialId, {
      trafficClass: "background",
    })
    const bucketLimitViolation = await getBucketLimitViolation({
      userId: session.user.id,
      credentialId: credential.id,
      bucket,
      entitlements,
    })
    if (bucketLimitViolation) {
      return NextResponse.json(
        {
          error: "Bucket limit reached for current plan",
          details: bucketLimitViolation,
        },
        { status: 400 }
      )
    }

    // Count files and storage in other buckets (to know how many slots/bytes are left for this bucket)
    const otherBucketCount = await prisma.fileMetadata.count({
      where: {
        userId: session.user.id,
        isFolder: false,
        NOT: { credentialId: credential.id, bucket },
      },
    })
    const otherBucketStorageAgg = await prisma.fileMetadata.aggregate({
      where: {
        userId: session.user.id,
        isFolder: false,
        NOT: { credentialId: credential.id, bucket },
      },
      _sum: { size: true },
    })
    const otherBucketStorageBytes = Number(otherBucketStorageAgg._sum.size ?? 0)

    const availableSlots = Number.isFinite(fileLimit)
      ? Math.max(0, fileLimit - otherBucketCount)
      : Number.POSITIVE_INFINITY
    const availableStorageBytes = Number.isFinite(storageLimit)
      ? Math.max(0, storageLimit - otherBucketStorageBytes)
      : Number.POSITIVE_INFINITY

    // Paginate through all objects in the bucket
    const s3Objects: {
      key: string
      extension: string
      size: number
      lastModified: Date
      isFolder: boolean
    }[] = []
    let continuationToken: string | undefined

    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      )

      for (const obj of response.Contents ?? []) {
        if (!obj.Key) continue
        s3Objects.push({
          key: obj.Key,
          extension: getObjectExtension(
            obj.Key,
            obj.Key.endsWith("/") && (obj.Size ?? 0) === 0
          ),
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? new Date(),
          isFolder: obj.Key.endsWith("/") && (obj.Size ?? 0) === 0,
        })
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined
    } while (continuationToken)

    const totalInS3 = s3Objects.length
    const totalFileObjectsInS3 = s3Objects.filter((obj) => !obj.isFolder).length
    const cachedEntries = await prisma.fileMetadata.findMany({
      where: {
        userId: session.user.id,
        credentialId: credential.id,
        bucket,
      },
      select: {
        id: true,
        key: true,
        isFolder: true,
      },
    })
    const cachedFileKeys = new Set(
      cachedEntries.filter((entry) => !entry.isFolder).map((entry) => entry.key)
    )

    // Limit entries to tier allowance (file count + storage)
    const objectsToSync: typeof s3Objects = []
    let remainingSlots = availableSlots
    let remainingStorageBytes = availableStorageBytes
    for (const object of s3Objects) {
      if (object.isFolder) {
        objectsToSync.push(object)
        continue
      }

      const alreadyCached = cachedFileKeys.has(object.key)
      const fitsSlots = alreadyCached || !Number.isFinite(remainingSlots) || remainingSlots > 0
      const fitsStorage = alreadyCached || !Number.isFinite(remainingStorageBytes) || remainingStorageBytes >= object.size
      if (fitsSlots && fitsStorage) {
        objectsToSync.push(object)
        if (!alreadyCached) {
          if (Number.isFinite(remainingSlots)) remainingSlots--
          if (Number.isFinite(remainingStorageBytes)) remainingStorageBytes -= object.size
        }
      }
    }
    const syncedFileObjects = objectsToSync.filter((obj) => !obj.isFolder).length
    const skippedDueToFileLimit = Math.max(0, totalFileObjectsInS3 - syncedFileObjects)

    // Upsert entries into FileMetadata
    let synced = 0
    for (const obj of objectsToSync) {
      await prisma.fileMetadata.upsert({
        where: {
          credentialId_bucket_key: {
            credentialId: credential.id,
            bucket,
            key: obj.key,
          },
        },
        create: {
          userId: session.user.id,
          credentialId: credential.id,
          bucket,
          key: obj.key,
          extension: obj.extension,
          size: BigInt(obj.size),
          lastModified: obj.lastModified,
          isFolder: obj.isFolder,
        },
        update: {
          extension: obj.extension,
          size: BigInt(obj.size),
          lastModified: obj.lastModified,
          isFolder: obj.isFolder,
        },
      })
      synced++
    }

    // Delete FileMetadata entries for objects no longer in S3
    const s3KeySet = new Set(s3Objects.map((o) => o.key))
    const staleEntries = cachedEntries.filter((entry) => !s3KeySet.has(entry.key))
    const staleIds = staleEntries.map((entry) => entry.id)

    if (staleIds.length > 0) {
      await prisma.fileMetadata.deleteMany({
        where: { id: { in: staleIds } },
      })
    }

    await rebuildUserExtensionStats(session.user.id)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "sync",
      path: "/api/s3/sync",
      method: "POST",
      target: `${bucket}`,
      metadata: {
        bucket,
        credentialId: credential.id,
        synced,
        totalInS3,
        skippedDueToFileLimit,
        staleRemoved: staleIds.length,
      },
      ...requestContext,
    })

    return NextResponse.json({ synced, total: totalInS3, skippedDueToFileLimit })
  } catch (error) {
    console.error("Failed to sync metadata:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "sync_failed",
        path: "/api/s3/sync",
        method: "POST",
        target: auditBucket || undefined,
        metadata: {
          error: error instanceof Error ? error.message : "sync_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to sync metadata" }, { status: 500 })
  }
}
