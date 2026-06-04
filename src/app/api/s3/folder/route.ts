import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { prisma } from "@/lib/db"
import { rebuildUserExtensionStats } from "@/lib/file-stats"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import { getBucketLimitViolation } from "@/lib/plan-limits"
import { createFolderSchema } from "@/lib/validations"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import { PutObjectCommand } from "@aws-sdk/client-s3"

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditFolderKey = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const body = await request.json()
    const parsed = createFolderSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId, key } = parsed.data
    auditBucket = bucket
    const { client, credential } = await getS3Client(session.user.id, credentialId)

    const entitlements = await getUserPlanEntitlements(session.user.id)
    if (!entitlements) {
      return NextResponse.json({ error: "Failed to resolve plan entitlements" }, { status: 403 })
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

    // Ensure key ends with /
    const folderKey = key.endsWith("/") ? key : `${key}/`
    auditFolderKey = folderKey

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: folderKey,
        Body: "",
      })
    )

    // Add FileMetadata entry for the folder
    await prisma.fileMetadata.upsert({
      where: {
        credentialId_bucket_key: {
          credentialId: credential.id,
          bucket,
          key: folderKey,
        },
      },
      create: {
        userId: session.user.id,
        credentialId: credential.id,
        bucket,
        key: folderKey,
        extension: "",
        size: BigInt(0),
        lastModified: new Date(),
        isFolder: true,
      },
      update: {
        extension: "",
        lastModified: new Date(),
      },
    })

    await rebuildUserExtensionStats(session.user.id)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "create_folder",
      path: "/api/s3/folder",
      method: "POST",
      target: folderKey,
      metadata: {
        bucket,
        credentialId: credential.id,
        key: folderKey,
      },
      ...requestContext,
    })

    return NextResponse.json({ key: folderKey })
  } catch (error) {
    console.error("Failed to create folder:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "create_folder_failed",
        path: "/api/s3/folder",
        method: "POST",
        target: auditFolderKey || undefined,
        metadata: {
          bucket: auditBucket || null,
          key: auditFolderKey || null,
          error: error instanceof Error ? error.message : "create_folder_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to create folder" }, { status: 500 })
  }
}
