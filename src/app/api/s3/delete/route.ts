import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { prisma } from "@/lib/db"
import { deleteObjectsSchema } from "@/lib/validations"
import type { Prisma } from "@prisma/client"
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3"

const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "ico"],
  video: ["mp4", "avi", "mov", "mkv", "flv", "wmv", "webm"],
  audio: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "wma"],
  document: ["pdf", "doc", "docx", "txt", "rtf", "odt", "xls", "xlsx"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2"],
  code: ["js", "ts", "tsx", "jsx", "py", "java", "cpp", "c", "go", "rs", "rb", "php", "html", "css", "json", "xml"],
}

function getFileType(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() || ""
  for (const [type, extensions] of Object.entries(FILE_TYPE_EXTENSIONS)) {
    if (extensions.includes(ext)) return type
  }
  return "other"
}

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

    const { bucket, credentialId, keys, prefixes, dryRun } = parsed.data
    const { client, credential } = await getS3Client(session.user.id, credentialId)

    if (dryRun) {
      const whereOr: Prisma.FileMetadataWhereInput[] = []

      if (keys && keys.length > 0) {
        whereOr.push({
          key: { in: keys },
        })
      }

      if (prefixes && prefixes.length > 0) {
        for (const prefix of prefixes) {
          whereOr.push({
            key: { startsWith: prefix },
          })
        }
      }

      if (whereOr.length === 0) {
        return NextResponse.json({
          dryRun: true,
          summary: {
            selectedFolders: 0,
            selectedFiles: 0,
            indexedFolders: 0,
            indexedFiles: 0,
            byType: {},
            byFolder: [],
          },
        })
      }

      const matches = await prisma.fileMetadata.findMany({
        where: {
          userId: session.user.id,
          credentialId: credential.id,
          bucket,
          OR: whereOr,
        },
        select: {
          key: true,
          isFolder: true,
        },
      })

      const uniqueMatches = new Map<string, { key: string; isFolder: boolean }>()
      for (const match of matches) {
        uniqueMatches.set(match.key, match)
      }
      const deduped = Array.from(uniqueMatches.values())

      const byType: Record<string, number> = {}
      for (const match of deduped) {
        if (match.isFolder) continue
        const type = getFileType(match.key)
        byType[type] = (byType[type] ?? 0) + 1
      }

      const byFolder = (prefixes ?? []).map((prefix) => {
        const filesInFolder = deduped.filter(
          (match) => !match.isFolder && match.key.startsWith(prefix)
        )
        const folderTypes: Record<string, number> = {}
        for (const file of filesInFolder) {
          const type = getFileType(file.key)
          folderTypes[type] = (folderTypes[type] ?? 0) + 1
        }
        return {
          prefix,
          fileCount: filesInFolder.length,
          byType: folderTypes,
        }
      })

      return NextResponse.json({
        dryRun: true,
        summary: {
          selectedFolders: prefixes?.length ?? 0,
          selectedFiles: keys?.length ?? 0,
          indexedFolders: deduped.filter((match) => match.isFolder).length,
          indexedFiles: deduped.filter((match) => !match.isFolder).length,
          byType,
          byFolder,
        },
      })
    }

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
