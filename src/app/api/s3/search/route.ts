import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import type { Prisma } from "@prisma/client"

const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "ico"],
  video: ["mp4", "avi", "mov", "mkv", "flv", "wmv", "webm"],
  audio: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "wma"],
  document: ["pdf", "doc", "docx", "txt", "rtf", "odt", "xls", "xlsx"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2"],
  code: ["js", "ts", "tsx", "jsx", "py", "java", "cpp", "c", "go", "rs", "rb", "php", "html", "css", "json", "xml"],
  other: [],
}

function buildTypeFilter(type: string): Prisma.FileMetadataWhereInput | null {
  if (!type || type === "all") return null

  const extensionFilters = (extensions: string[]): Prisma.FileMetadataWhereInput[] =>
    extensions.map((extension) => ({
      key: {
        endsWith: `.${extension}`,
        mode: "insensitive",
      },
    }))

  if (type === "other") {
    const knownExtensions = Array.from(
      new Set(
        Object.entries(FILE_TYPE_EXTENSIONS)
          .filter(([fileType]) => fileType !== "other")
          .flatMap(([, extensions]) => extensions)
      )
    )

    if (knownExtensions.length === 0) return null

    return {
      NOT: {
        OR: extensionFilters(knownExtensions),
      },
    }
  }

  const extensions = FILE_TYPE_EXTENSIONS[type] ?? []
  if (extensions.length === 0) return null

  return {
    OR: extensionFilters(extensions),
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = request.nextUrl
    const query = searchParams.get("q") || ""
    const bucketsParam = searchParams.get("buckets") || ""
    const credentialIdsParam = searchParams.get("credentialIds") || ""
    const scopeParams = searchParams.getAll("scope")
    const type = searchParams.get("type") || ""
    const sortBy = (searchParams.get("sortBy") || "name") as "name" | "size" | "lastModified"
    const sortDir = (searchParams.get("sortDir") || "asc") as "asc" | "desc"
    const skipRaw = Number(searchParams.get("skip") || "0")
    const takeRaw = Number(searchParams.get("take") || "100")
    const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? Math.floor(skipRaw) : 0
    const take = Number.isFinite(takeRaw) ? Math.min(100, Math.max(1, Math.floor(takeRaw))) : 100

    if (query.trim().length < 2) {
      return NextResponse.json({ results: [], total: 0 })
    }

    // Parse bucket filter
    const buckets = bucketsParam ? bucketsParam.split(",").map((b) => b.trim()) : []
    const credentialIds = credentialIdsParam
      ? credentialIdsParam.split(",").map((id) => id.trim()).filter(Boolean)
      : []
    const scopedFilters = scopeParams
      .map((scope) => {
        const [credentialId, bucket] = scope.split("::")
        if (!credentialId || !bucket) return null
        return { credentialId, bucket }
      })
      .filter((value): value is { credentialId: string; bucket: string } => Boolean(value))

    // Build where clause
    const whereClause: Prisma.FileMetadataWhereInput = {
      userId: session.user.id,
      isFolder: false,
    }

    // Text search
    whereClause.key = {
      contains: query,
      mode: "insensitive",
    }

    if (scopedFilters.length > 0) {
      whereClause.OR = scopedFilters
    } else {
      if (buckets.length > 0) {
        whereClause.bucket = {
          in: buckets,
        }
      }

      if (credentialIds.length > 0) {
        whereClause.credentialId = {
          in: credentialIds,
        }
      }
    }

    const typeFilter = buildTypeFilter(type)
    if (typeFilter) {
      const existingAnd = whereClause.AND
      if (Array.isArray(existingAnd)) {
        whereClause.AND = [...existingAnd, typeFilter]
      } else if (existingAnd) {
        whereClause.AND = [existingAnd, typeFilter]
      } else {
        whereClause.AND = [typeFilter]
      }
    }

    const total = await prisma.fileMetadata.count({ where: whereClause })

    // Query database
    const results = await prisma.fileMetadata.findMany({
      where: whereClause,
      select: {
        id: true,
        key: true,
        bucket: true,
        credentialId: true,
        size: true,
        lastModified: true,
      },
      orderBy:
        sortBy === "name"
          ? { key: sortDir }
          : sortBy === "size"
            ? { size: sortDir }
            : { lastModified: sortDir },
      skip,
      take,
    })

    // Map response
    const data = results.map((r) => ({
      id: r.id,
      key: r.key,
      bucket: r.bucket,
      credentialId: r.credentialId,
      size: Number(r.size),
      lastModified: r.lastModified.toISOString(),
    }))

    return NextResponse.json({ results: data, total })
  } catch (error) {
    console.error("Failed to search files:", error)
    const message = error instanceof Error ? error.message : "Failed to search files"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
