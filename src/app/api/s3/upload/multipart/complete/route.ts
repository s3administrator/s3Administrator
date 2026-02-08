import { NextRequest, NextResponse } from "next/server"
import { CompleteMultipartUploadCommand } from "@aws-sdk/client-s3"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"

interface MultipartPart {
  ETag: string
  PartNumber: number
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { bucket, key, credentialId, uploadId, parts } = body

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

    return NextResponse.json({ completed: true })
  } catch (error) {
    console.error("Failed to complete multipart upload:", error)
    const message = error instanceof Error ? error.message : "Failed to complete multipart upload"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
