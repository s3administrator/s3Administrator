import { NextRequest, NextResponse } from "next/server"
import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditKey = ""
  let auditUploadId = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const body = await request.json()
    const { bucket, key, credentialId, uploadId } = body
    auditBucket = typeof bucket === "string" ? bucket : ""
    auditKey = typeof key === "string" ? key : ""
    auditUploadId = typeof uploadId === "string" ? uploadId : ""

    if (!bucket || !key || !uploadId) {
      return NextResponse.json(
        { error: "bucket, key and uploadId are required" },
        { status: 400 }
      )
    }

    const { client } = await getS3Client(session.user.id, credentialId)

    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      })
    )

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "multipart_abort",
      path: "/api/s3/upload/multipart/abort",
      method: "POST",
      target: key,
      metadata: {
        bucket,
        credentialId: typeof credentialId === "string" ? credentialId : null,
        uploadId,
      },
      ...requestContext,
    })

    return NextResponse.json({ aborted: true })
  } catch (error) {
    console.error("Failed to abort multipart upload:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "multipart_abort_failed",
        path: "/api/s3/upload/multipart/abort",
        method: "POST",
        target: auditKey || undefined,
        metadata: {
          bucket: auditBucket || null,
          uploadId: auditUploadId || null,
          error: error instanceof Error ? error.message : "multipart_abort_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to abort multipart upload" }, { status: 500 })
  }
}
