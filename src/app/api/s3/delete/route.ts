import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { prisma } from "@/lib/db"
import { deleteObjectsSchema } from "@/lib/validations"
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3"

async function listAllKeysWithPrefix(
  client: InstanceType<typeof import("@aws-sdk/client-s3").S3Client>,
  bucket: string,
  prefix: string
): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    )

    for (const obj of response.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key)
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined
  } while (continuationToken)

  return keys
}

async function batchDeleteObjects(
  client: InstanceType<typeof import("@aws-sdk/client-s3").S3Client>,
  bucket: string,
  keys: string[]
): Promise<number> {
  let deleted = 0

  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    )
    deleted += batch.length - (response.Errors?.length ?? 0)
  }

  return deleted
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const parsed = deleteObjectsSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, keys, prefixes } = parsed.data
    const { client, credential } = await getS3Client(session.user.id)

    let totalDeleted = 0
    const allDeletedKeys: string[] = []

    // Delete individual keys
    if (keys && keys.length > 0) {
      const deleted = await batchDeleteObjects(client, bucket, keys)
      totalDeleted += deleted
      allDeletedKeys.push(...keys)
    }

    // Delete by prefix (recursive folder delete)
    if (prefixes && prefixes.length > 0) {
      for (const prefix of prefixes) {
        const prefixKeys = await listAllKeysWithPrefix(client, bucket, prefix)
        if (prefixKeys.length > 0) {
          const deleted = await batchDeleteObjects(client, bucket, prefixKeys)
          totalDeleted += deleted
          allDeletedKeys.push(...prefixKeys)
        }
      }
    }

    // Remove matching FileMetadata entries from Prisma
    if (allDeletedKeys.length > 0) {
      await prisma.fileMetadata.deleteMany({
        where: {
          userId: session.user.id,
          credentialId: credential.id,
          bucket,
          key: { in: allDeletedKeys },
        },
      })
    }

    // Also delete metadata for any prefix patterns
    if (prefixes && prefixes.length > 0) {
      for (const prefix of prefixes) {
        await prisma.fileMetadata.deleteMany({
          where: {
            userId: session.user.id,
            credentialId: credential.id,
            bucket,
            key: { startsWith: prefix },
          },
        })
      }
    }

    return NextResponse.json({ deleted: totalDeleted })
  } catch (error) {
    console.error("Failed to delete objects:", error)
    const message = error instanceof Error ? error.message : "Failed to delete objects"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
