import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import { s3OperationSchema } from "@/lib/validations"
import { PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

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

    const body = await request.json()
    const parsed = s3OperationSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters" },
        { status: 400 }
      )
    }
    const { bucket, key, credentialId } = parsed.data
    auditBucket = bucket
    auditKey = key

    const { client } = await getS3Client(session.user.id, credentialId)

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
    })

    const url = await getSignedUrl(client, command, { expiresIn: 3600 })

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "upload_prepare",
      path: "/api/s3/upload",
      method: "POST",
      target: key,
      metadata: {
        bucket,
        credentialId: credentialId ?? null,
      },
      ...requestContext,
    })

    return NextResponse.json({ url, key })
  } catch (error) {
    console.error("Failed to generate upload URL:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "upload_prepare_failed",
        path: "/api/s3/upload",
        method: "POST",
        target: auditKey || undefined,
        metadata: {
          bucket: auditBucket || null,
          error: error instanceof Error ? error.message : "upload_prepare_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to generate upload URL" }, { status: 500 })
  }
}
