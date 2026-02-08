import { NextRequest, NextResponse } from "next/server"
import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { bucket, key, credentialId, uploadId } = body

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

    return NextResponse.json({ aborted: true })
  } catch (error) {
    console.error("Failed to abort multipart upload:", error)
    const message = error instanceof Error ? error.message : "Failed to abort multipart upload"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
