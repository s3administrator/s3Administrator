import { NextRequest, NextResponse } from "next/server"
import { z } from "zod/v4"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { bucketManageSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import {
  cleanupIncompleteMultipart,
  getS3ErrorCode,
  getS3ErrorMessage,
  isPermissionStyleS3Error,
} from "@/lib/s3-multipart-incomplete"

const multipartCleanupSchema = bucketManageSchema.extend({
  retryAttempts: z.number().int().min(1).max(10).optional(),
})

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditCredentialId = ""
  let retryAttempts = 3
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(
      session.user.id,
      "s3-multipart-incomplete-cleanup",
      20,
      60_000
    )
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 })
    }
    const parsed = multipartCleanupSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId, retryAttempts: requestedRetryAttempts } = parsed.data
    auditBucket = bucket
    retryAttempts = requestedRetryAttempts ?? 3

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    auditCredentialId = credential.id

    const cleanup = await cleanupIncompleteMultipart(client, bucket, retryAttempts)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "multipart_incomplete_cleanup",
      path: "/api/s3/multipart/incomplete/cleanup",
      method: "POST",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        retryAttempts,
        attemptedUploads: cleanup.attemptedUploads,
        cleanedUploads: cleanup.cleanedUploads,
        failedUploads: cleanup.failedUploads.length,
        remainingUploads: cleanup.remaining.summary.uploads,
        remainingParts: cleanup.remaining.summary.parts,
        remainingIncompleteSize: cleanup.remaining.summary.incompleteSize,
      },
      ...requestContext,
    })

    return NextResponse.json({
      bucket,
      credentialId: credential.id,
      attemptedUploads: cleanup.attemptedUploads,
      cleanedUploads: cleanup.cleanedUploads,
      failedUploads: cleanup.failedUploads,
      remaining: cleanup.remaining,
    })
  } catch (error) {
    console.error("Failed to cleanup incomplete multipart uploads:", error)

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "multipart_incomplete_cleanup_failed",
        path: "/api/s3/multipart/incomplete/cleanup",
        method: "POST",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          credentialId: auditCredentialId || null,
          retryAttempts,
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
      { error: "Failed to cleanup incomplete multipart uploads" },
      { status: 500 }
    )
  }
}
