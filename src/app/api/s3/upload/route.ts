import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
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
    const { bucket, key, credentialId } = body
    auditBucket = typeof bucket === "string" ? bucket : ""
    auditKey = typeof key === "string" ? key : ""

    if (!bucket || !key) {
      return NextResponse.json(
        { error: "bucket and key are required" },
        { status: 400 }
      )
    }

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
        credentialId: typeof credentialId === "string" ? credentialId : null,
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
    const message = error instanceof Error ? error.message : "Failed to generate upload URL"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
