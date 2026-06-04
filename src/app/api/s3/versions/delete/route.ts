import { NextRequest, NextResponse } from "next/server"
import { z } from "zod/v4"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { s3BucketSchema, s3KeySchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import {
  deleteObjectVersion,
  getS3ErrorCode,
  getS3ErrorMessage,
  isPermissionStyleS3Error,
} from "@/lib/s3-object-versions"

const deleteVersionBodySchema = z.object({
  bucket: s3BucketSchema,
  credentialId: z.string().optional(),
  key: s3KeySchema,
  versionId: z.string().min(1).max(1024),
})

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditKey = ""
  let auditVersionId = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-versions-delete", 60, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const body = await request.json().catch(() => null)
    const parsed = deleteVersionBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId, key, versionId } = parsed.data
    auditBucket = bucket
    auditKey = key
    auditVersionId = versionId

    const { client, credential } = await getS3Client(session.user.id, credentialId)

    await deleteObjectVersion(client, bucket, key, versionId)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "version_delete",
      path: "/api/s3/versions/delete",
      method: "POST",
      target: key,
      metadata: {
        bucket,
        credentialId: credential.id,
        versionId,
      },
      ...requestContext,
    })

    return NextResponse.json({ deleted: true })
  } catch (error) {
    console.error("Failed to delete object version:", error)

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "version_delete_failed",
        path: "/api/s3/versions/delete",
        method: "POST",
        target: auditKey || undefined,
        metadata: {
          bucket: auditBucket || null,
          versionId: auditVersionId || null,
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
      { error: "Failed to delete object version" },
      { status: 500 }
    )
  }
}
