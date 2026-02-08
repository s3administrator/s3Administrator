import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

function extractFilename(key: string): string {
  const normalized = key.endsWith("/") ? key.slice(0, -1) : key
  const filename = normalized.split("/").pop() || "download"
  return filename || "download"
}

function toContentDispositionFilename(filename: string): string {
  return filename.replace(/["\\]/g, "_")
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { bucket, key, credentialId } = body

    if (!bucket || !key) {
      return NextResponse.json(
        { error: "bucket and key are required" },
        { status: 400 }
      )
    }

    const { client } = await getS3Client(session.user.id, credentialId)
    const filename = extractFilename(key)

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${toContentDispositionFilename(filename)}"`,
    })

    const url = await getSignedUrl(client, command, { expiresIn: 3600 })

    return NextResponse.json({ url, filename })
  } catch (error) {
    console.error("Failed to generate download URL:", error)
    const message = error instanceof Error ? error.message : "Failed to generate download URL"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
