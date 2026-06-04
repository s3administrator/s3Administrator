import { NextRequest, NextResponse } from "next/server"
import { ListPartsCommand } from "@aws-sdk/client-s3"
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
        { error: "bucket, key, and uploadId are required" },
        { status: 400 }
      )
    }

    const { client } = await getS3Client(session.user.id, credentialId)

    const allParts: Array<{ partNumber: number; etag: string; size: number }> = []
    let partNumberMarker: string | undefined

    do {
      const response = await client.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        })
      )

      for (const part of response.Parts ?? []) {
        if (part.PartNumber != null && part.ETag) {
          allParts.push({
            partNumber: part.PartNumber,
            etag: part.ETag,
            size: part.Size ?? 0,
          })
        }
      }

      partNumberMarker = response.IsTruncated
        ? String(response.NextPartNumberMarker)
        : undefined
    } while (partNumberMarker)

    return NextResponse.json({ parts: allParts })
  } catch (error) {
    console.error("Failed to list multipart parts:", error)
    return NextResponse.json(
      { error: "Failed to list parts" },
      { status: 500 }
    )
  }
}
