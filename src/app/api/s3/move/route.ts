import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { prisma } from "@/lib/db"
import { getObjectExtension, rebuildUserExtensionStats } from "@/lib/file-stats"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import { getBucketLimitViolation } from "@/lib/plan-limits"
import { moveObjectSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import { moveMediaThumbnailForObject } from "@/lib/media-thumbnails"
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3"

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditSourceBucket = ""
  let auditOperationCount = 0
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id
    const limitResult = rateLimitByUser(session.user.id, "s3-move", 30, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const body = await request.json()
    const parsed = moveObjectSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId, sourceBucket, operations } = parsed.data
    const fromBucket = sourceBucket ?? bucket
    auditBucket = bucket
    auditSourceBucket = fromBucket
    auditOperationCount = operations.length
    const { client, credential } = await getS3Client(session.user.id, credentialId)

    if (fromBucket !== bucket) {
      const entitlements = await getUserPlanEntitlements(session.user.id)
      if (!entitlements) {
        return NextResponse.json(
          { error: "Failed to resolve plan entitlements" },
          { status: 403 }
        )
      }

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
    }

    let movedCount = 0
    let thumbnailMoved = 0
    let thumbnailQueued = 0

    for (const { from, to } of operations) {
      const isFolder = from.endsWith("/")

      if (isFolder) {
        // Moving a folder: list all objects with that prefix
        let continuationToken: string | undefined

        do {
          const listResponse = await client.send(
            new ListObjectsV2Command({
              Bucket: fromBucket,
              Prefix: from,
              ContinuationToken: continuationToken,
            })
          )

          for (const obj of listResponse.Contents ?? []) {
            if (!obj.Key) continue

            // Replace the source prefix with the destination prefix
            const newKey = to + obj.Key.slice(from.length)

            // Copy to new location
            await client.send(
              new CopyObjectCommand({
                Bucket: bucket,
                CopySource: encodeURIComponent(`${fromBucket}/${obj.Key}`),
                Key: newKey,
              })
            )

            // Delete from old location
            await client.send(
              new DeleteObjectCommand({
                Bucket: fromBucket,
                Key: obj.Key,
              })
            )

            // Update FileMetadata entry
            await prisma.fileMetadata.updateMany({
              where: {
                userId: session.user.id,
                credentialId: credential.id,
                bucket: fromBucket,
                key: obj.Key,
              },
              data: {
                bucket,
                key: newKey,
                extension: getObjectExtension(newKey, newKey.endsWith("/")),
              },
            })

            if (!(newKey.endsWith("/") && (obj.Size ?? 0) === 0)) {
              const thumbnailResult = await moveMediaThumbnailForObject({
                userId: session.user.id,
                credentialId: credential.id,
                fromBucket,
                fromKey: obj.Key,
                toBucket: bucket,
                toKey: newKey,
                sourceLastModified: obj.LastModified ?? new Date(),
                sourceSize: BigInt(obj.Size ?? 0),
              })
              if (thumbnailResult.moved) thumbnailMoved++
              if (thumbnailResult.queued) thumbnailQueued++
            }

            movedCount++
          }

          continuationToken = listResponse.IsTruncated
            ? listResponse.NextContinuationToken
            : undefined
        } while (continuationToken)
      } else {
        // Moving a single file
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: encodeURIComponent(`${fromBucket}/${from}`),
            Key: to,
          })
        )

        await client.send(
          new DeleteObjectCommand({
            Bucket: fromBucket,
            Key: from,
          })
        )

        // Update FileMetadata entry
        const existingMetadata = await prisma.fileMetadata.findFirst({
          where: {
            userId: session.user.id,
            credentialId: credential.id,
            bucket: fromBucket,
            key: from,
          },
          select: {
            size: true,
            lastModified: true,
          },
        })

        await prisma.fileMetadata.updateMany({
          where: {
            userId: session.user.id,
            credentialId: credential.id,
            bucket: fromBucket,
            key: from,
          },
          data: {
            bucket,
            key: to,
            extension: getObjectExtension(to, to.endsWith("/")),
          },
        })

        if (!to.endsWith("/")) {
          const thumbnailResult = await moveMediaThumbnailForObject({
            userId: session.user.id,
            credentialId: credential.id,
            fromBucket,
            fromKey: from,
            toBucket: bucket,
            toKey: to,
            sourceLastModified: existingMetadata?.lastModified ?? new Date(),
            sourceSize: existingMetadata?.size ?? BigInt(0),
          })
          if (thumbnailResult.moved) thumbnailMoved++
          if (thumbnailResult.queued) thumbnailQueued++
        }

        movedCount++
      }
    }

    await rebuildUserExtensionStats(session.user.id)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "move",
      path: "/api/s3/move",
      method: "POST",
      target: bucket,
      metadata: {
        bucket,
        fromBucket,
        credentialId: credential.id,
        operations: operations.length,
        moved: movedCount,
        thumbnailMoved,
        thumbnailQueued,
      },
      ...requestContext,
    })

    return NextResponse.json({ moved: movedCount })
  } catch (error) {
    console.error("Failed to move objects:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "move_failed",
        path: "/api/s3/move",
        method: "POST",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          fromBucket: auditSourceBucket || null,
          operations: auditOperationCount,
          error: error instanceof Error ? error.message : "move_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to move objects" }, { status: 500 })
  }
}
