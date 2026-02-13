import { NextRequest, NextResponse } from "next/server"
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import { getMediaTypeFromExtension, type MediaType } from "@/lib/media"
import { galleryListSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import {
  getThumbnailBucketName,
  getThumbnailStorageClient,
  getThumbnailUrlTtlSeconds,
} from "@/lib/thumbnail-storage"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import type { GalleryItem, ThumbnailStatus } from "@/types"

type CursorPayload = {
  offset: number
}

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
  mediaType: MediaType
  isVideo: boolean
  thumbnailStatus: ThumbnailStatus
  thumbnailBucket: string | null
  thumbnailKey: string | null
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url")
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      offset?: unknown
    }

    if (typeof parsed.offset !== "number") return null
    if (!Number.isFinite(parsed.offset) || parsed.offset < 0) return null

    return { offset: Math.floor(parsed.offset) }
  } catch {
    return null
  }
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

    const entitlements = await getUserPlanEntitlements(session.user.id)
    if (!entitlements) {
      return NextResponse.json({ error: "Failed to resolve plan entitlements" }, { status: 403 })
    }
    const previewEnabled = entitlements.thumbnailCache

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
    const ttlSeconds = getThumbnailUrlTtlSeconds()

    let thumbnailClient: S3Client | null = null
    let defaultThumbnailBucket: string | null = null
    try {
      thumbnailClient = getThumbnailStorageClient()
      defaultThumbnailBucket = getThumbnailBucketName()
    } catch {
      thumbnailClient = null
      defaultThumbnailBucket = null
    }

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
      mediaType: MediaType
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
      if (!entryMediaType) {
        continue
      }

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
        isVideo: entryMediaType === "video",
      })
    }

    const videoKeys = previewEnabled
      ? directFiles.filter((entry) => entry.isVideo).map((entry) => entry.key)
      : []
    const thumbnailRows = videoKeys.length > 0
      ? await prisma.mediaThumbnail.findMany({
          where: {
            userId: session.user.id,
            credentialId: credential.id,
            bucket,
            key: { in: videoKeys },
          },
          select: {
            key: true,
            status: true,
            thumbnailBucket: true,
            thumbnailKey: true,
          },
        })
      : []

    const thumbnailByKey = new Map(
      thumbnailRows.map((row) => [
        row.key,
        {
          status: row.status as ThumbnailStatus,
          thumbnailBucket: row.thumbnailBucket,
          thumbnailKey: row.thumbnailKey,
        },
      ])
    )

    const folderCandidates: FolderCandidate[] = Array.from(folderMap.entries()).map(([key, meta]) => ({
      kind: "folder",
      key,
      lastModified: meta.lastModified,
      fileCount: meta.fileCount,
      totalSize: meta.totalSize,
    }))

    const fileCandidates: FileCandidate[] = directFiles.map((entry) => {
      const thumbnail = thumbnailByKey.get(entry.key)
      return {
        kind: "file",
        id: entry.id,
        key: entry.key,
        size: Number(entry.size),
        lastModified: entry.lastModified,
        extension: entry.extension,
        mediaType: entry.mediaType,
        isVideo: entry.isVideo,
        thumbnailStatus:
          previewEnabled && entry.isVideo ? (thumbnail?.status ?? "pending") : null,
        thumbnailBucket: thumbnail?.thumbnailBucket ?? defaultThumbnailBucket,
        thumbnailKey: thumbnail?.thumbnailKey ?? null,
      }
    })

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
            previewUrl: null,
            thumbnailStatus: null,
            isVideo: false,
            isFolder: true,
            fileCount: candidate.fileCount,
            totalSize: candidate.totalSize,
          }
        }

        let previewUrl: string | null = null

        if (!previewEnabled) {
          previewUrl = null
        } else if (!candidate.isVideo) {
          try {
            previewUrl = await getSignedUrl(
              client,
              new GetObjectCommand({
                Bucket: bucket,
                Key: candidate.key,
                ResponseContentDisposition: "inline",
                ResponseCacheControl: `public, max-age=${ttlSeconds}`,
              }),
              { expiresIn: ttlSeconds }
            )
          } catch {
            previewUrl = null
          }
        } else if (
          candidate.thumbnailStatus === "ready" &&
          candidate.thumbnailKey &&
          candidate.thumbnailBucket &&
          thumbnailClient
        ) {
          try {
            previewUrl = await getSignedUrl(
              thumbnailClient,
              new GetObjectCommand({
                Bucket: candidate.thumbnailBucket,
                Key: candidate.thumbnailKey,
                ResponseContentDisposition: "inline",
                ResponseCacheControl: `public, max-age=${ttlSeconds}`,
              }),
              { expiresIn: ttlSeconds }
            )
          } catch {
            previewUrl = null
          }
        }

        return {
          id: candidate.id,
          key: candidate.key,
          size: candidate.size,
          lastModified: candidate.lastModified.toISOString(),
          extension: candidate.extension,
          mediaType: candidate.mediaType,
          previewUrl,
          thumbnailStatus: candidate.thumbnailStatus,
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
          previewEnabled,
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
