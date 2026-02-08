import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { bucket, key } = body

    if (!bucket || !key) {
      return NextResponse.json(
        { error: "bucket and key are required" },
        { status: 400 }
      )
    }

    const { client } = await getS3Client(session.user.id)

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
    })

    const url = await getSignedUrl(client, command, { expiresIn: 3600 })

    return NextResponse.json({ url, key })
  } catch (error) {
    console.error("Failed to generate upload URL:", error)
    const message = error instanceof Error ? error.message : "Failed to generate upload URL"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
