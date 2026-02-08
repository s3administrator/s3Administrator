import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { prisma } from "@/lib/db"
import { moveObjectSchema } from "@/lib/validations"
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3"

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const parsed = moveObjectSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId, sourceBucket, operations } = parsed.data
    const fromBucket = sourceBucket ?? bucket
    const { client, credential } = await getS3Client(session.user.id, credentialId)

    let movedCount = 0

    for (const { from, to } of operations) {
      const isFolder = from.endsWith("/")

      if (isFolder) {
        // Moving a folder: list all objects with that prefix
        let continuationToken: string | undefined

        do {
          const listResponse = await client.send(
            new ListObjectsV2Command({
              Bucket: fromBucket,
              Prefix: from,
              ContinuationToken: continuationToken,
            })
          )

          for (const obj of listResponse.Contents ?? []) {
            if (!obj.Key) continue

            // Replace the source prefix with the destination prefix
            const newKey = to + obj.Key.slice(from.length)

            // Copy to new location
            await client.send(
              new CopyObjectCommand({
                Bucket: bucket,
                CopySource: encodeURIComponent(`${fromBucket}/${obj.Key}`),
                Key: newKey,
              })
            )

            // Delete from old location
            await client.send(
              new DeleteObjectCommand({
                Bucket: fromBucket,
                Key: obj.Key,
              })
            )

            // Update FileMetadata entry
            await prisma.fileMetadata.updateMany({
              where: {
                userId: session.user.id,
                credentialId: credential.id,
                bucket: fromBucket,
                key: obj.Key,
              },
              data: {
                bucket,
                key: newKey,
              },
            })

            movedCount++
          }

          continuationToken = listResponse.IsTruncated
            ? listResponse.NextContinuationToken
            : undefined
        } while (continuationToken)
      } else {
        // Moving a single file
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: encodeURIComponent(`${fromBucket}/${from}`),
            Key: to,
          })
        )

        await client.send(
          new DeleteObjectCommand({
            Bucket: fromBucket,
            Key: from,
          })
        )

        // Update FileMetadata entry
        await prisma.fileMetadata.updateMany({
          where: {
            userId: session.user.id,
            credentialId: credential.id,
            bucket: fromBucket,
            key: from,
          },
          data: {
            bucket,
            key: to,
          },
        })

        movedCount++
      }
    }

    return NextResponse.json({ moved: movedCount })
  } catch (error) {
    console.error("Failed to move objects:", error)
    const message = error instanceof Error ? error.message : "Failed to move objects"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
