import { NextRequest, NextResponse } from "next/server"
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { getGalleryExtensions, getMediaTypeFromExtension } from "@/lib/media"
import { galleryListSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import {
  getThumbnailBucketName,
  getThumbnailStorageClient,
  getThumbnailUrlTtlSeconds,
} from "@/lib/thumbnail-storage"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import type { GalleryItem, MediaType, ThumbnailStatus } from "@/types"

type GalleryRow = {
  id: string
  key: string
  size: bigint
  lastModified: Date
  extension: string
  thumbnailStatus: string | null
  thumbnailBucket: string | null
  thumbnailKey: string | null
}

type DecodedCursor = {
  lastModified: Date
  id: string
}

function encodeCursor(lastModified: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({
      lastModified: lastModified.toISOString(),
      id,
    }),
    "utf8"
  ).toString("base64url")
}

function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      lastModified?: unknown
      id?: unknown
    }
    if (typeof parsed.id !== "string") return null
    if (typeof parsed.lastModified !== "string") return null
    const date = new Date(parsed.lastModified)
    if (Number.isNaN(date.getTime())) return null
    return { id: parsed.id, lastModified: date }
  } catch {
    return null
  }
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
    const extensions = getGalleryExtensions(mediaType)
    const cursorData = cursor ? decodeCursor(cursor) : null

    if (cursor && !cursorData) {
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

    const rows = await prisma.$queryRaw<GalleryRow[]>(
      Prisma.sql`
        SELECT
          fm."id" AS "id",
          fm."key" AS "key",
          fm."size" AS "size",
          fm."lastModified" AS "lastModified",
          fm."extension" AS "extension",
          mt."status" AS "thumbnailStatus",
          mt."thumbnailBucket" AS "thumbnailBucket",
          mt."thumbnailKey" AS "thumbnailKey"
        FROM "FileMetadata" fm
        LEFT JOIN "MediaThumbnail" mt
          ON mt."userId" = fm."userId"
         AND mt."credentialId" = fm."credentialId"
         AND mt."bucket" = fm."bucket"
         AND mt."key" = fm."key"
        WHERE fm."userId" = ${session.user.id}
          AND fm."credentialId" = ${credential.id}
          AND fm."bucket" = ${bucket}
          AND fm."isFolder" = false
          AND fm."key" LIKE ${resolvedPrefix + "%"}
          AND fm."extension" IN (${Prisma.join(extensions)})
          ${
            cursorData
              ? Prisma.sql`AND (fm."lastModified", fm."id") < (${cursorData.lastModified}, ${cursorData.id})`
              : Prisma.empty
          }
        ORDER BY fm."lastModified" DESC, fm."id" DESC
        LIMIT ${limit + 1}
      `
    )

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows

    const items = await Promise.all(
      pageRows.map(async (row): Promise<GalleryItem> => {
        const media = (getMediaTypeFromExtension(row.extension) ?? "image") as MediaType
        const isVideo = media === "video"
        let previewUrl: string | null = null
        let status: ThumbnailStatus = null

        if (!isVideo) {
          try {
            previewUrl = await getSignedUrl(
              client,
              new GetObjectCommand({
                Bucket: bucket,
                Key: row.key,
                ResponseContentDisposition: "inline",
                ResponseCacheControl: `public, max-age=${ttlSeconds}`,
              }),
              { expiresIn: ttlSeconds }
            )
          } catch {
            previewUrl = null
          }
        } else {
          status = (row.thumbnailStatus as ThumbnailStatus) ?? "pending"
          const thumbnailBucket = row.thumbnailBucket || defaultThumbnailBucket
          if (status === "ready" && row.thumbnailKey && thumbnailClient && thumbnailBucket) {
            try {
              previewUrl = await getSignedUrl(
                thumbnailClient,
                new GetObjectCommand({
                  Bucket: thumbnailBucket,
                  Key: row.thumbnailKey,
                  ResponseContentDisposition: "inline",
                  ResponseCacheControl: `public, max-age=${ttlSeconds}`,
                }),
                { expiresIn: ttlSeconds }
              )
            } catch {
              previewUrl = null
            }
          }
        }

        return {
          id: row.id,
          key: row.key,
          size: Number(row.size),
          lastModified: row.lastModified.toISOString(),
          extension: row.extension,
          mediaType: media,
          previewUrl,
          thumbnailStatus: status,
          isVideo,
        }
      })
    )

    const last = items[items.length - 1]
    const nextCursor = hasMore && last
      ? encodeCursor(new Date(last.lastModified), last.id)
      : null

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
