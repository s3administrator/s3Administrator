import { NextRequest, NextResponse } from "next/server"
import { CreateMultipartUploadCommand } from "@aws-sdk/client-s3"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { bucket, key, credentialId, contentType } = body

    if (!bucket || !key) {
      return NextResponse.json(
        { error: "bucket and key are required" },
        { status: 400 }
      )
    }

    const { client } = await getS3Client(session.user.id, credentialId)

    const response = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: typeof contentType === "string" ? contentType : undefined,
      })
    )

    if (!response.UploadId) {
      return NextResponse.json(
        { error: "Failed to create multipart upload" },
        { status: 500 }
      )
    }

    return NextResponse.json({ uploadId: response.UploadId })
  } catch (error) {
    console.error("Failed to start multipart upload:", error)
    const message = error instanceof Error ? error.message : "Failed to start multipart upload"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
