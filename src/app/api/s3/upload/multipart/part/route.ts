import { NextRequest, NextResponse } from "next/server"
import { UploadPartCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { isStoraderaProvider } from "@/lib/s3-provider"

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { bucket, key, credentialId, uploadId, partNumber } = body

    if (!bucket || !key || !uploadId || !partNumber) {
      return NextResponse.json(
        { error: "bucket, key, uploadId and partNumber are required" },
        { status: 400 }
      )
    }

    const normalizedPartNumber = Number(partNumber)
    if (!Number.isInteger(normalizedPartNumber) || normalizedPartNumber < 1 || normalizedPartNumber > 10000) {
      return NextResponse.json(
        { error: "partNumber must be an integer between 1 and 10000" },
        { status: 400 }
      )
    }

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    const isStoradera = isStoraderaProvider(credential.provider)

    let url: string
    if (isStoradera) {
      const params = new URLSearchParams({
        bucket,
        key,
        uploadId,
        partNumber: String(normalizedPartNumber),
      })
      if (credentialId) {
        params.set("credentialId", credentialId)
      }
      url = `/api/s3/upload/multipart/part-proxy?${params.toString()}`
    } else {
      url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: normalizedPartNumber,
        }),
        { expiresIn: 3600 }
      )
    }

    return NextResponse.json({ url })
  } catch (error) {
    console.error("Failed to create part upload URL:", error)
    return NextResponse.json({ error: "Failed to create part upload URL" }, { status: 500 })
  }
}
