import { NextRequest, NextResponse } from "next/server"
import { z } from "zod/v4"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { s3BucketSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import {
  cleanupNoncurrentVersions,
  getS3ErrorCode,
  getS3ErrorMessage,
  isPermissionStyleS3Error,
} from "@/lib/s3-object-versions"

const cleanupBodySchema = z.object({
  bucket: s3BucketSchema,
  credentialId: z.string().optional(),
  retryAttempts: z.number().int().min(1).max(10).optional(),
})

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditCredentialId = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-versions-cleanup", 20, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const body = await request.json().catch(() => null)
    const parsed = cleanupBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId, retryAttempts } = parsed.data
    auditBucket = bucket

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    auditCredentialId = credential.id

    const result = await cleanupNoncurrentVersions(client, bucket, retryAttempts)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "versions_noncurrent_cleanup",
      path: "/api/s3/versions/cleanup",
      method: "POST",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        attemptedVersions: result.attemptedVersions,
        cleanedVersions: result.cleanedVersions,
        failedVersions: result.failedVersions.length,
        remainingNoncurrent: result.remaining.summary.noncurrentVersions,
        remainingDeleteMarkers: result.remaining.summary.deleteMarkers,
        remainingSize: result.remaining.summary.noncurrentSize,
      },
      ...requestContext,
    })

    return NextResponse.json({
      bucket,
      credentialId: credential.id,
      attemptedVersions: result.attemptedVersions,
      cleanedVersions: result.cleanedVersions,
      failedVersions: result.failedVersions,
      remaining: result.remaining,
    })
  } catch (error) {
    console.error("Failed to cleanup non-current versions:", error)

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "versions_noncurrent_cleanup_failed",
        path: "/api/s3/versions/cleanup",
        method: "POST",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          credentialId: auditCredentialId || null,
          error: getS3ErrorMessage(error),
          code: getS3ErrorCode(error) || null,
        },
        ...requestContext,
      })
    }

    if (isPermissionStyleS3Error(error)) {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 })
    }

    return NextResponse.json(
      { error: "Failed to cleanup non-current versions" },
      { status: 500 }
    )
  }
}
