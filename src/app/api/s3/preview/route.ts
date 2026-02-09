import { NextRequest, NextResponse } from "next/server"
import { GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { previewSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getThumbnailUrlTtlSeconds } from "@/lib/thumbnail-storage"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditKey = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-preview", 120, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const body = await request.json()
    const parsed = previewSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, key, credentialId } = parsed.data
    auditBucket = bucket
    auditKey = key
    const { client, credential } = await getS3Client(session.user.id, credentialId)
    const ttlSeconds = getThumbnailUrlTtlSeconds()

    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: "inline",
        ResponseCacheControl: `public, max-age=${ttlSeconds}`,
      }),
      { expiresIn: ttlSeconds }
    )

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "preview_prepare",
      path: "/api/s3/preview",
      method: "POST",
      target: key,
      metadata: {
        bucket,
        key,
        credentialId: credential.id,
      },
      ...requestContext,
    })

    return NextResponse.json({ url })
  } catch (error) {
    console.error("Failed to create preview URL:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "preview_prepare_failed",
        path: "/api/s3/preview",
        method: "POST",
        target: auditKey || undefined,
        metadata: {
          bucket: auditBucket || null,
          error: error instanceof Error ? error.message : "preview_prepare_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to create preview URL" }, { status: 500 })
  }
}
