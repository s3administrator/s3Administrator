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
    const { bucket, key, credentialId, uploadId, partNumbers } = body

    if (
      !bucket ||
      !key ||
      !uploadId ||
      !Array.isArray(partNumbers) ||
      partNumbers.length === 0
    ) {
      return NextResponse.json(
        { error: "bucket, key, uploadId and partNumbers are required" },
        { status: 400 }
      )
    }

    if (partNumbers.length > 100) {
      return NextResponse.json(
        { error: "Maximum 100 part numbers per batch request" },
        { status: 400 }
      )
    }

    const normalizedParts = partNumbers
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10000)

    if (normalizedParts.length === 0) {
      return NextResponse.json(
        { error: "No valid part numbers provided" },
        { status: 400 }
      )
    }

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    const isStoradera = isStoraderaProvider(credential.provider)

    let urls: Array<{ partNumber: number; url: string }>
    if (isStoradera) {
      urls = normalizedParts.map((partNumber) => {
        const params = new URLSearchParams({
          bucket,
          key,
          uploadId,
          partNumber: String(partNumber),
        })
        if (credentialId) {
          params.set("credentialId", credentialId)
        }
        return { partNumber, url: `/api/s3/upload/multipart/part-proxy?${params.toString()}` }
      })
    } else {
      urls = await Promise.all(
        normalizedParts.map(async (partNumber) => {
          const url = await getSignedUrl(
            client,
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
            }),
            { expiresIn: 3600 }
          )
          return { partNumber, url }
        })
      )
    }

    return NextResponse.json({ urls })
  } catch (error) {
    console.error("Failed to create batch part URLs:", error)
    return NextResponse.json(
      { error: "Failed to create batch part URLs" },
      { status: 500 }
    )
  }
}
