import { Prisma } from "@prisma/client"

export const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "ico", "tiff", "tif", "ai"],
  video: ["mp4", "avi", "mov", "mkv", "flv", "wmv", "webm"],
  audio: [
    "aac",
    "ac3",
    "aiff",
    "amr",
    "au",
    "flac",
    "m4a",
    "mid",
    "mka",
    "mp3",
    "ogg",
    "ra",
    "voc",
    "wav",
    "wma",
  ],
  document: ["pdf", "doc", "docx", "txt", "rtf", "odt", "ods", "odp", "xls", "xlsx"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2"],
  code: ["js", "ts", "tsx", "jsx", "py", "java", "cpp", "c", "go", "rs", "rb", "php", "html", "css", "scss", "json", "xml", "yaml", "yml", "sh", "bash", "sql"],
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

export type FileSearchSortBy = "name" | "size" | "lastModified"
export type FileSearchSortDir = "asc" | "desc"

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

function getKnownExtensionsForOtherType(): string[] {
  return Array.from(
    new Set(
      Object.entries(FILE_TYPE_EXTENSIONS)
        .filter(([fileType]) => fileType !== "other")
        .flatMap(([, extensions]) => extensions)
    )
  )
}

function buildTypeFilter(type: string): Prisma.FileMetadataWhereInput | null {
  if (!type || type === "all") return null

  if (type === "other") {
    const knownExtensions = getKnownExtensionsForOtherType()

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

export function normalizeFileSearchSortBy(value: string | null | undefined): FileSearchSortBy {
  return value === "size" || value === "lastModified" || value === "name"
    ? value
    : "name"
}

export function normalizeFileSearchSortDir(value: string | null | undefined): FileSearchSortDir {
  return value === "desc" ? "desc" : "asc"
}

export function buildFileSearchSqlWhereClause({
  userId,
  query,
  buckets = [],
  credentialIds = [],
  scopes = [],
  type = "all",
}: BuildFileSearchWhereParams): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`fm."userId" = ${userId}`,
    Prisma.sql`fm."isFolder" = false`,
  ]

  const trimmedQuery = query.trim()
  if (trimmedQuery) {
    conditions.push(
      Prisma.sql`LOWER(regexp_replace(fm."key", '^.*/', '')) LIKE LOWER(${`%${trimmedQuery}%`})`
    )
  }

  if (scopes.length > 0) {
    const scopeClauses = scopes.map((scope) =>
      Prisma.sql`(fm."credentialId" = ${scope.credentialId} AND fm."bucket" = ${scope.bucket})`
    )
    conditions.push(Prisma.sql`(${Prisma.join(scopeClauses, " OR ")})`)
  } else {
    if (buckets.length > 0) {
      conditions.push(Prisma.sql`fm."bucket" IN (${Prisma.join(buckets)})`)
    }
    if (credentialIds.length > 0) {
      conditions.push(Prisma.sql`fm."credentialId" IN (${Prisma.join(credentialIds)})`)
    }
  }

  if (type && type !== "all") {
    if (type === "other") {
      const knownExtensions = getKnownExtensionsForOtherType()
      if (knownExtensions.length > 0) {
        conditions.push(Prisma.sql`fm."extension" NOT IN (${Prisma.join(knownExtensions)})`)
      }
    } else {
      const extensions = FILE_TYPE_EXTENSIONS[type] ?? []
      if (extensions.length > 0) {
        conditions.push(Prisma.sql`fm."extension" IN (${Prisma.join(extensions)})`)
      }
    }
  }

  return Prisma.sql`${Prisma.join(conditions, " AND ")}`
}

export function buildFileSearchOrderBySql(
  sortBy: FileSearchSortBy,
  sortDir: FileSearchSortDir
): Prisma.Sql {
  if (sortBy === "size") {
    return sortDir === "desc"
      ? Prisma.sql`fm."size" DESC, fm."key" DESC`
      : Prisma.sql`fm."size" ASC, fm."key" ASC`
  }

  if (sortBy === "lastModified") {
    return sortDir === "desc"
      ? Prisma.sql`fm."lastModified" DESC, fm."key" DESC`
      : Prisma.sql`fm."lastModified" ASC, fm."key" ASC`
  }

  return sortDir === "desc"
    ? Prisma.sql`LOWER(regexp_replace(fm."key", '^.*/', '')) DESC, fm."key" DESC`
    : Prisma.sql`LOWER(regexp_replace(fm."key", '^.*/', '')) ASC, fm."key" ASC`
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
