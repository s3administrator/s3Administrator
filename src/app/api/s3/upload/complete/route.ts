import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { getObjectExtension, rebuildUserExtensionStats } from "@/lib/file-stats"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import {
  getAdditionalFileLimitViolation,
  getBucketLimitViolation,
} from "@/lib/plan-limits"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"

interface UploadCompleteItem {
  key: string
  size: number
  lastModified?: string
}

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditItemsCount = 0
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const body = await request.json()
    const bucket = typeof body?.bucket === "string" ? body.bucket : ""
    const credentialId = typeof body?.credentialId === "string" ? body.credentialId : undefined
    const items = Array.isArray(body?.items) ? (body.items as UploadCompleteItem[]) : []
    auditBucket = bucket
    auditItemsCount = items.length

    if (!bucket || items.length === 0) {
      return NextResponse.json(
        { error: "bucket and items are required" },
        { status: 400 }
      )
    }

    const entitlements = await getUserPlanEntitlements(session.user.id)
    if (!entitlements) {
      return NextResponse.json({ error: "Failed to resolve plan entitlements" }, { status: 403 })
    }

    if (items.length > 1 && !entitlements.multipleUpload) {
      return NextResponse.json(
        {
          error: "Multiple upload finalize is disabled for the current plan",
          details: {
            plan: entitlements.slug,
            planSource: entitlements.source,
          },
        },
        { status: 403 }
      )
    }

    const { credential } = await getS3Client(session.user.id, credentialId)
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

    const normalizedItems = items.filter(
      (item): item is UploadCompleteItem => Boolean(item?.key && typeof item.key === "string")
    )
    if (normalizedItems.length === 0) {
      return NextResponse.json({ error: "No valid upload items were provided" }, { status: 400 })
    }

    const uniqueKeys = Array.from(new Set(normalizedItems.map((item) => item.key)))
    const existingRows = await prisma.fileMetadata.findMany({
      where: {
        userId: session.user.id,
        credentialId: credential.id,
        bucket,
        key: { in: uniqueKeys },
        isFolder: false,
      },
      select: { key: true },
    })
    const existingKeys = new Set(existingRows.map((row) => row.key))
    const newFileCount = uniqueKeys.filter((key) => !existingKeys.has(key)).length

    const fileLimitViolation = await getAdditionalFileLimitViolation({
      userId: session.user.id,
      requestedAdditionalFiles: newFileCount,
      entitlements,
    })
    if (fileLimitViolation) {
      return NextResponse.json(
        {
          error: "Cached file limit reached for current plan",
          details: fileLimitViolation,
        },
        { status: 400 }
      )
    }

    for (const item of normalizedItems) {
      const size = Number.isFinite(item.size) && item.size >= 0 ? item.size : 0
      const lastModified = item.lastModified ? new Date(item.lastModified) : new Date()

      await prisma.fileMetadata.upsert({
        where: {
          credentialId_bucket_key: {
            credentialId: credential.id,
            bucket,
            key: item.key,
          },
        },
        create: {
          userId: session.user.id,
          credentialId: credential.id,
          bucket,
          key: item.key,
          extension: getObjectExtension(item.key, false),
          size: BigInt(size),
          lastModified,
          isFolder: false,
        },
        update: {
          extension: getObjectExtension(item.key, false),
          size: BigInt(size),
          lastModified,
          isFolder: false,
        },
      })
    }

    await rebuildUserExtensionStats(session.user.id)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "upload_finalize",
      path: "/api/s3/upload/complete",
      method: "POST",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        items: normalizedItems.length,
      },
      ...requestContext,
    })

    return NextResponse.json({ updated: normalizedItems.length })
  } catch (error) {
    console.error("Failed to finalize uploaded metadata:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "upload_finalize_failed",
        path: "/api/s3/upload/complete",
        method: "POST",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          items: auditItemsCount,
          error: error instanceof Error ? error.message : "upload_finalize_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to finalize uploaded metadata" }, { status: 500 })
  }
}
