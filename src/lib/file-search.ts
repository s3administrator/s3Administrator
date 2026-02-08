import type { Prisma } from "@prisma/client"

export const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "ico"],
  video: ["mp4", "avi", "mov", "mkv", "flv", "wmv", "webm"],
  audio: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "wma"],
  document: ["pdf", "doc", "docx", "txt", "rtf", "odt", "xls", "xlsx"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2"],
  code: ["js", "ts", "tsx", "jsx", "py", "java", "cpp", "c", "go", "rs", "rb", "php", "html", "css", "json", "xml"],
  other: [],
}

export interface BucketScope {
  credentialId: string
  bucket: string
}

export interface BuildFileSearchWhereParams {
  userId: string
  query: string
  buckets?: string[]
  credentialIds?: string[]
  scopes?: BucketScope[]
  type?: string
}

export function parseCsvValues(value: string): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function parseScopes(values: string[]): BucketScope[] {
  return values
    .map((scope) => {
      const [credentialId, bucket] = scope.split("::")
      if (!credentialId || !bucket) return null
      return { credentialId, bucket }
    })
    .filter((value): value is BucketScope => Boolean(value))
}

function buildTypeFilter(type: string): Prisma.FileMetadataWhereInput | null {
  if (!type || type === "all") return null

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
        extension: {
          in: knownExtensions,
        },
      },
    }
  }

  const extensions = FILE_TYPE_EXTENSIONS[type] ?? []
  if (extensions.length === 0) return null

  return {
    extension: {
      in: extensions,
    },
  }
}

export function buildFileSearchWhereClause({
  userId,
  query,
  buckets = [],
  credentialIds = [],
  scopes = [],
  type = "all",
}: BuildFileSearchWhereParams): Prisma.FileMetadataWhereInput {
  const whereClause: Prisma.FileMetadataWhereInput = {
    userId,
    isFolder: false,
  }

  if (query.trim()) {
    whereClause.key = {
      contains: query,
      mode: "insensitive",
    }
  }

  if (scopes.length > 0) {
    whereClause.OR = scopes
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

  return whereClause
}
