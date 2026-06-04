import { NextRequest, NextResponse } from "next/server"
import { GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { isStoraderaProvider } from "@/lib/s3-provider"
import { encodeCursor, decodeCursor } from "@/lib/pagination"
import { getMediaTypeFromExtension, getPreviewType, isGallerySupportedExtension, type MediaType, type PreviewType } from "@/lib/media"
import { galleryListSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import type { GalleryItem } from "@/types"

const PREVIEW_URL_TTL_SECONDS = 86400 // 24 hours

type FolderCandidate = {
  kind: "folder"
  key: string
  lastModified: Date
  fileCount: number
  totalSize: number
}

type FileCandidate = {
  kind: "file"
  id: string
  key: string
  size: number
  lastModified: Date
  extension: string
  mediaType: MediaType | null
  previewType: PreviewType | null
  isVideo: boolean
}

function compareCandidates(a: FolderCandidate | FileCandidate, b: FolderCandidate | FileCandidate): number {
  const timeDiff = b.lastModified.getTime() - a.lastModified.getTime()
  if (timeDiff !== 0) return timeDiff

  if (a.kind !== b.kind) {
    return a.kind === "folder" ? -1 : 1
  }

  return a.key.localeCompare(b.key)
}

export async function GET(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-gallery-list", 120, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const { searchParams } = request.nextUrl
    const parsed = galleryListSchema.safeParse({
      bucket: searchParams.get("bucket") ?? undefined,
      prefix: searchParams.get("prefix") ?? undefined,
      credentialId: searchParams.get("credentialId") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
      mediaType: searchParams.get("mediaType") ?? undefined,
    })

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId, prefix = "", cursor, limit, mediaType } = parsed.data
    auditBucket = bucket
    const resolvedPrefix = prefix.trim()
    const cursorData = cursor ? decodeCursor(cursor) : { offset: 0 }

    if (!cursorData) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 })
    }

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    const isStoradera = isStoraderaProvider(credential.provider)

    const allEntries = await prisma.fileMetadata.findMany({
      where: {
        userId: session.user.id,
        credentialId: credential.id,
        bucket,
        key: { startsWith: resolvedPrefix },
      },
      select: {
        id: true,
        key: true,
        size: true,
        lastModified: true,
        isFolder: true,
        extension: true,
      },
    })

    const folderMap = new Map<string, { lastModified: Date; fileCount: number; totalSize: number }>()
    const directFiles: Array<{
      id: string
      key: string
      size: bigint
      lastModified: Date
      extension: string
      mediaType: MediaType | null
      previewType: PreviewType | null
      isVideo: boolean
    }> = []

    for (const entry of allEntries) {
      const remainder = entry.key.slice(resolvedPrefix.length)
      if (!remainder) continue

      const slashIndex = remainder.indexOf("/")

      if (slashIndex !== -1) {
        const folderKey = resolvedPrefix + remainder.slice(0, slashIndex + 1)
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
            fileCount: entryCount,
            totalSize: entrySize,
          })
        }

        continue
      }

      if (entry.isFolder) {
        continue
      }

      const entryMediaType = getMediaTypeFromExtension(entry.extension)
      const entryPreviewType = getPreviewType(entry.extension)

      if (!isGallerySupportedExtension(entry.extension)) {
        continue
      }

      // When filtering by image/video, only include media files
      if (mediaType !== "all" && entryMediaType !== mediaType) {
        continue
      }

      directFiles.push({
        id: entry.id,
        key: entry.key,
        size: entry.size,
        lastModified: entry.lastModified,
        extension: entry.extension,
        mediaType: entryMediaType,
        previewType: entryPreviewType,
        isVideo: entryMediaType === "video",
      })
    }

    const folderCandidates: FolderCandidate[] = Array.from(folderMap.entries()).map(([key, meta]) => ({
      kind: "folder",
      key,
      lastModified: meta.lastModified,
      fileCount: meta.fileCount,
      totalSize: meta.totalSize,
    }))

    const fileCandidates: FileCandidate[] = directFiles.map((entry) => ({
      kind: "file",
      id: entry.id,
      key: entry.key,
      size: Number(entry.size),
      lastModified: entry.lastModified,
      extension: entry.extension,
      mediaType: entry.mediaType,
      previewType: entry.previewType,
      isVideo: entry.isVideo,
    }))

    const merged = [...folderCandidates, ...fileCandidates].sort(compareCandidates)

    const start = cursorData.offset
    const endExclusive = start + limit
    const pageCandidates = merged.slice(start, endExclusive)
    const hasMore = endExclusive < merged.length
    const nextCursor = hasMore ? encodeCursor(endExclusive) : null

    const items = await Promise.all(
      pageCandidates.map(async (candidate): Promise<GalleryItem> => {
        if (candidate.kind === "folder") {
          return {
            id: `folder:${candidate.key}`,
            key: candidate.key,
            size: candidate.totalSize,
            lastModified: candidate.lastModified.toISOString(),
            extension: "",
            mediaType: null,
            previewType: null,
            previewUrl: null,
            isVideo: false,
            isFolder: true,
            fileCount: candidate.fileCount,
            totalSize: candidate.totalSize,
          }
        }

        let previewUrl: string | null = null

        // Media files need preview URLs for client-side thumbnail generation.
        // Code files need preview URLs for fetching content to syntax-highlight.
        const needsPreviewUrl = candidate.mediaType || candidate.previewType === "code"
        if (needsPreviewUrl) {
          if (isStoradera) {
            // Storadera does not support presigned URLs; use the preview proxy with the original file
            const params = new URLSearchParams({ bucket, key: candidate.key })
            if (credentialId) {
              params.set("credentialId", credentialId)
            }
            previewUrl = `/api/s3/preview/proxy?${params.toString()}`
          } else {
            // Generate presigned URL to the original file — client uses this for thumbnail generation
            try {
              previewUrl = await getSignedUrl(
                client,
                new GetObjectCommand({
                  Bucket: bucket,
                  Key: candidate.key,
                  ResponseContentDisposition: "inline",
                  ResponseCacheControl: `public, max-age=${PREVIEW_URL_TTL_SECONDS}`,
                }),
                { expiresIn: PREVIEW_URL_TTL_SECONDS }
              )
            } catch {
              previewUrl = null
            }
          }
        }

        return {
          id: candidate.id,
          key: candidate.key,
          size: candidate.size,
          lastModified: candidate.lastModified.toISOString(),
          extension: candidate.extension,
          mediaType: candidate.mediaType,
          previewType: candidate.previewType,
          previewUrl,
          isVideo: candidate.isVideo,
          isFolder: false,
          fileCount: undefined,
          totalSize: undefined,
        }
      })
    )

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "gallery_list",
      path: "/api/s3/gallery",
      method: "GET",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        prefix: resolvedPrefix,
        mediaType,
        limit,
        returned: items.length,
        hasMore,
        offset: start,
      },
      ...requestContext,
    })

    return NextResponse.json({
      items,
      nextCursor,
      hasMore,
    })
  } catch (error) {
    console.error("Failed to list gallery items:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "gallery_list_failed",
        path: "/api/s3/gallery",
        method: "GET",
        target: auditBucket || undefined,
        metadata: {
          error: error instanceof Error ? error.message : "gallery_list_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to list gallery items" }, { status: 500 })
  }
}
