import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { listObjectsSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = request.nextUrl
    const parsed = listObjectsSchema.safeParse({
      bucket: searchParams.get("bucket") ?? undefined,
      prefix: searchParams.get("prefix") ?? undefined,
      credentialId: searchParams.get("credentialId") ?? undefined,
    })

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, prefix, credentialId } = parsed.data
    const { credential } = await getS3Client(session.user.id, credentialId)
    const normalizedPrefix = prefix ?? ""

    const allEntries = await prisma.fileMetadata.findMany({
      where: {
        userId: session.user.id,
        credentialId: credential.id,
        bucket,
        key: { startsWith: normalizedPrefix },
      },
      select: { key: true, size: true, lastModified: true, isFolder: true },
    })

    const folderMap = new Map<string, { lastModified: Date; totalSize: number; fileCount: number }>()
    const files: { key: string; size: number; lastModified: string; isFolder: boolean }[] = []

    for (const entry of allEntries) {
      const remainder = entry.key.slice(normalizedPrefix.length)
      if (remainder === "") continue

      const slashIndex = remainder.indexOf("/")

      if (slashIndex !== -1) {
        const folderKey = normalizedPrefix + remainder.slice(0, slashIndex + 1)
        const existing = folderMap.get(folderKey)
        const entrySize = entry.isFolder ? 0 : Number(entry.size)
        const entryCount = entry.isFolder ? 0 : 1

        if (existing) {
          existing.totalSize += entrySize
          existing.fileCount += entryCount
          if (entry.lastModified > existing.lastModified) {
            existing.lastModified = entry.lastModified
          }
        } else {
          folderMap.set(folderKey, {
            lastModified: entry.lastModified,
            totalSize: entrySize,
            fileCount: entryCount,
          })
        }
      } else if (!entry.isFolder) {
        files.push({
          key: entry.key,
          size: Number(entry.size),
          lastModified: entry.lastModified.toISOString(),
          isFolder: false,
        })
      }
    }

    const folders = Array.from(folderMap.entries()).map(([key, meta]) => ({
      key,
      size: meta.totalSize,
      lastModified: meta.lastModified.toISOString(),
      isFolder: true,
      totalSize: meta.totalSize,
      fileCount: meta.fileCount,
    }))

    return NextResponse.json({
      folders: folders.sort((a, b) => a.key.localeCompare(b.key)),
      files: files.sort((a, b) => a.key.localeCompare(b.key)),
    })
  } catch (error) {
    console.error("Failed to list objects:", error)
    return NextResponse.json({ error: "Failed to list objects" }, { status: 500 })
  }
}
