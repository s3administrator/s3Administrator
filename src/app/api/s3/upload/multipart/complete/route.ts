import { NextRequest, NextResponse } from "next/server"
import { CompleteMultipartUploadCommand } from "@aws-sdk/client-s3"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"

interface MultipartPart {
  ETag: string
  PartNumber: number
}

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
    const { bucket, key, credentialId, uploadId, parts } = body
    auditBucket = typeof bucket === "string" ? bucket : ""
    auditKey = typeof key === "string" ? key : ""
    auditUploadId = typeof uploadId === "string" ? uploadId : ""

    if (!bucket || !key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return NextResponse.json(
        { error: "bucket, key, uploadId and parts are required" },
        { status: 400 }
      )
    }

    const normalizedParts = (parts as MultipartPart[])
      .filter((part) => typeof part?.ETag === "string" && Number.isInteger(part?.PartNumber))
      .map((part) => ({
        ETag: part.ETag,
        PartNumber: part.PartNumber,
      }))
      .sort((a, b) => a.PartNumber - b.PartNumber)

    if (normalizedParts.length === 0) {
      return NextResponse.json(
        { error: "No valid upload parts were provided" },
        { status: 400 }
      )
    }

    const { client } = await getS3Client(session.user.id, credentialId)

    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: normalizedParts,
        },
      })
    )

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "multipart_complete",
      path: "/api/s3/upload/multipart/complete",
      method: "POST",
      target: key,
      metadata: {
        bucket,
        credentialId: typeof credentialId === "string" ? credentialId : null,
        uploadId,
        parts: normalizedParts.length,
      },
      ...requestContext,
    })

    return NextResponse.json({ completed: true })
  } catch (error) {
    console.error("Failed to complete multipart upload:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "multipart_complete_failed",
        path: "/api/s3/upload/multipart/complete",
        method: "POST",
        target: auditKey || undefined,
        metadata: {
          bucket: auditBucket || null,
          uploadId: auditUploadId || null,
          error: error instanceof Error ? error.message : "multipart_complete_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to complete multipart upload" }, { status: 500 })
  }
}
