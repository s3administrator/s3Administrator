import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3"
import {
  getS3ErrorCode,
  getS3ErrorMessage,
  isPermissionStyleS3Error,
} from "@/lib/s3-multipart-incomplete"

const PAGINATION_PAGE_LIMIT = 10_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObjectVersionRef {
  key: string
  versionId: string
  size: number
  lastModifiedUtc: string
  isLatest: boolean
  isDeleteMarker: boolean
}

export interface NoncurrentVersionsSummary {
  noncurrentVersions: number
  deleteMarkers: number
  noncurrentSize: number
}

export interface NoncurrentVersionsScanResult {
  summary: NoncurrentVersionsSummary
  versions: ObjectVersionRef[]
}

export interface NoncurrentVersionsScanPageResult {
  pageSummary: NoncurrentVersionsSummary
  versions: ObjectVersionRef[]
  nextKeyMarker: string | null
  nextVersionIdMarker: string | null
  hasMore: boolean
}

export interface VersionCleanupFailure {
  key: string
  versionId: string
  error: string
}

export interface VersionCleanupResult {
  attemptedVersions: number
  cleanedVersions: number
  failedVersions: VersionCleanupFailure[]
  remaining: NoncurrentVersionsScanResult
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceSize(raw: unknown): number {
  if (typeof raw === "number") return Math.max(0, raw)
  if (typeof raw === "string" || typeof raw === "bigint") {
    const n = Number(raw)
    return Number.isFinite(n) ? Math.max(0, n) : 0
  }
  return 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Scan: all non-current versions in a bucket
// ---------------------------------------------------------------------------

export async function scanNoncurrentVersions(
  client: S3Client,
  bucket: string,
  collectDetails: boolean
): Promise<NoncurrentVersionsScanResult> {
  const allVersions: ObjectVersionRef[] = []
  let keyMarker: string | undefined
  let versionIdMarker: string | undefined
  let pageCount = 0

  while (true) {
    pageCount += 1
    if (pageCount > PAGINATION_PAGE_LIMIT) {
      throw new Error("Version scan exceeded pagination safety limit")
    }

    const response = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        MaxKeys: 1000,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      })
    )

    for (const v of response.Versions ?? []) {
      if (!v.Key || !v.VersionId) continue
      if (v.IsLatest) continue // skip current versions
      allVersions.push({
        key: v.Key,
        versionId: v.VersionId,
        size: coerceSize(v.Size),
        lastModifiedUtc: v.LastModified?.toISOString() ?? "",
        isLatest: false,
        isDeleteMarker: false,
      })
    }

    for (const dm of response.DeleteMarkers ?? []) {
      if (!dm.Key || !dm.VersionId) continue
      allVersions.push({
        key: dm.Key,
        versionId: dm.VersionId,
        size: 0,
        lastModifiedUtc: dm.LastModified?.toISOString() ?? "",
        isLatest: dm.IsLatest ?? false,
        isDeleteMarker: true,
      })
    }

    if (!response.IsTruncated) break

    const nextKey = response.NextKeyMarker
    const nextVersionId = response.NextVersionIdMarker
    if (!nextKey && !nextVersionId) {
      throw new Error("Version scan pagination stalled (missing cursor)")
    }
    if (nextKey === keyMarker && nextVersionId === versionIdMarker) {
      throw new Error("Version scan pagination stalled (cursor did not advance)")
    }

    keyMarker = nextKey
    versionIdMarker = nextVersionId
  }

  let noncurrentVersions = 0
  let deleteMarkers = 0
  let noncurrentSize = 0
  const details: ObjectVersionRef[] = []

  for (const v of allVersions) {
    if (v.isDeleteMarker) {
      deleteMarkers += 1
    } else {
      noncurrentVersions += 1
      noncurrentSize += v.size
    }
    if (collectDetails) {
      details.push(v)
    }
  }

  console.log(
    `[version-scan] bucket=${bucket} result: ${noncurrentVersions} non-current version(s), ${deleteMarkers} delete marker(s), ${(noncurrentSize / (1024 * 1024)).toFixed(1)} MB`
  )

  if (collectDetails) {
    details.sort((a, b) => {
      const tsDiff =
        (b.lastModifiedUtc ? Date.parse(b.lastModifiedUtc) : 0) -
        (a.lastModifiedUtc ? Date.parse(a.lastModifiedUtc) : 0)
      if (tsDiff !== 0) return tsDiff
      const keyDiff = a.key.localeCompare(b.key)
      if (keyDiff !== 0) return keyDiff
      return a.versionId.localeCompare(b.versionId)
    })
  }

  return {
    summary: { noncurrentVersions, deleteMarkers, noncurrentSize },
    versions: collectDetails ? details : [],
  }
}

// ---------------------------------------------------------------------------
// Scan: paginated non-current versions
// ---------------------------------------------------------------------------

interface VersionPageParams {
  limit: number
  keyMarker?: string
  versionIdMarker?: string
}

export async function scanNoncurrentVersionsPage(
  client: S3Client,
  bucket: string,
  params: VersionPageParams
): Promise<NoncurrentVersionsScanPageResult> {
  const limit = Math.max(1, Math.min(200, Math.trunc(params.limit)))
  const collected: ObjectVersionRef[] = []
  let keyMarker = params.keyMarker
  let versionIdMarker = params.versionIdMarker
  let pageCount = 0

  while (collected.length < limit) {
    pageCount += 1
    if (pageCount > PAGINATION_PAGE_LIMIT) {
      throw new Error("Version page scan exceeded pagination safety limit")
    }

    const response = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        MaxKeys: 1000,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      })
    )

    // Process non-current versions
    for (const v of response.Versions ?? []) {
      if (!v.Key || !v.VersionId) continue
      if (v.IsLatest) continue
      collected.push({
        key: v.Key,
        versionId: v.VersionId,
        size: coerceSize(v.Size),
        lastModifiedUtc: v.LastModified?.toISOString() ?? "",
        isLatest: false,
        isDeleteMarker: false,
      })
      if (collected.length >= limit) break
    }

    // Process delete markers
    if (collected.length < limit) {
      for (const dm of response.DeleteMarkers ?? []) {
        if (!dm.Key || !dm.VersionId) continue
        collected.push({
          key: dm.Key,
          versionId: dm.VersionId,
          size: 0,
          lastModifiedUtc: dm.LastModified?.toISOString() ?? "",
          isLatest: dm.IsLatest ?? false,
          isDeleteMarker: true,
        })
        if (collected.length >= limit) break
      }
    }

    if (!response.IsTruncated) {
      return buildPageResult(collected, null, null, false)
    }

    const nextKey = response.NextKeyMarker
    const nextVersionId = response.NextVersionIdMarker
    if (!nextKey && !nextVersionId) {
      throw new Error("Version page scan pagination stalled (missing cursor)")
    }
    if (nextKey === keyMarker && nextVersionId === versionIdMarker) {
      throw new Error("Version page scan pagination stalled (cursor did not advance)")
    }

    keyMarker = nextKey
    versionIdMarker = nextVersionId

    if (collected.length >= limit) {
      return buildPageResult(collected, keyMarker ?? null, versionIdMarker ?? null, true)
    }
  }

  return buildPageResult(
    collected,
    keyMarker ?? null,
    versionIdMarker ?? null,
    true
  )
}

function buildPageResult(
  versions: ObjectVersionRef[],
  nextKeyMarker: string | null,
  nextVersionIdMarker: string | null,
  hasMore: boolean
): NoncurrentVersionsScanPageResult {
  let noncurrentVersions = 0
  let deleteMarkers = 0
  let noncurrentSize = 0

  for (const v of versions) {
    if (v.isDeleteMarker) {
      deleteMarkers += 1
    } else {
      noncurrentVersions += 1
      noncurrentSize += v.size
    }
  }

  return {
    pageSummary: { noncurrentVersions, deleteMarkers, noncurrentSize },
    versions,
    nextKeyMarker,
    nextVersionIdMarker,
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// List: all versions for a prefix (explorer view)
// ---------------------------------------------------------------------------

interface ListVersionsForPrefixParams {
  prefix?: string
  limit?: number
  keyMarker?: string
  versionIdMarker?: string
}

export interface ListVersionsForPrefixResult {
  versions: ObjectVersionRef[]
  nextKeyMarker: string | null
  nextVersionIdMarker: string | null
  hasMore: boolean
}

export async function listVersionsForPrefix(
  client: S3Client,
  bucket: string,
  params: ListVersionsForPrefixParams
): Promise<ListVersionsForPrefixResult> {
  const limit = Math.max(1, Math.min(1000, params.limit ?? 500))
  const collected: ObjectVersionRef[] = []
  let keyMarker = params.keyMarker
  let versionIdMarker = params.versionIdMarker
  let pageCount = 0

  while (collected.length < limit) {
    pageCount += 1
    if (pageCount > PAGINATION_PAGE_LIMIT) {
      throw new Error("Version prefix list exceeded pagination safety limit")
    }

    const response = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: params.prefix || undefined,
        Delimiter: "/",
        MaxKeys: 1000,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      })
    )

    for (const v of response.Versions ?? []) {
      if (!v.Key || !v.VersionId) continue
      collected.push({
        key: v.Key,
        versionId: v.VersionId,
        size: coerceSize(v.Size),
        lastModifiedUtc: v.LastModified?.toISOString() ?? "",
        isLatest: v.IsLatest ?? false,
        isDeleteMarker: false,
      })
      if (collected.length >= limit) break
    }

    if (collected.length < limit) {
      for (const dm of response.DeleteMarkers ?? []) {
        if (!dm.Key || !dm.VersionId) continue
        collected.push({
          key: dm.Key,
          versionId: dm.VersionId,
          size: 0,
          lastModifiedUtc: dm.LastModified?.toISOString() ?? "",
          isLatest: dm.IsLatest ?? false,
          isDeleteMarker: true,
        })
        if (collected.length >= limit) break
      }
    }

    if (!response.IsTruncated) {
      return {
        versions: collected,
        nextKeyMarker: null,
        nextVersionIdMarker: null,
        hasMore: false,
      }
    }

    const nextKey = response.NextKeyMarker
    const nextVersionId = response.NextVersionIdMarker
    if (!nextKey && !nextVersionId) break
    if (nextKey === keyMarker && nextVersionId === versionIdMarker) break

    keyMarker = nextKey
    versionIdMarker = nextVersionId
  }

  return {
    versions: collected,
    nextKeyMarker: keyMarker ?? null,
    nextVersionIdMarker: versionIdMarker ?? null,
    hasMore: collected.length >= limit,
  }
}

// ---------------------------------------------------------------------------
// Delete: single version
// ---------------------------------------------------------------------------

export async function deleteObjectVersion(
  client: S3Client,
  bucket: string,
  key: string,
  versionId: string
): Promise<void> {
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
    })
  )
}

// ---------------------------------------------------------------------------
// Cleanup: all non-current versions + delete markers
// ---------------------------------------------------------------------------

const DELETE_BATCH_SIZE = 1000

export async function cleanupNoncurrentVersions(
  client: S3Client,
  bucket: string,
  retryAttempts: number = 3
): Promise<VersionCleanupResult> {
  const retries = Math.max(1, Math.min(10, Math.trunc(retryAttempts)))
  const initialScan = await scanNoncurrentVersions(client, bucket, true)

  let cleanedVersions = 0
  const failedVersions: VersionCleanupFailure[] = []

  // Batch the versions into groups of DELETE_BATCH_SIZE
  for (let i = 0; i < initialScan.versions.length; i += DELETE_BATCH_SIZE) {
    const batch = initialScan.versions.slice(i, i + DELETE_BATCH_SIZE)
    let batchCleaned = false

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const deleteResult = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: batch.map((v) => ({ Key: v.key, VersionId: v.versionId })),
              Quiet: true,
            },
          })
        )

        // Check for individual errors in the batch
        const errors = deleteResult.Errors ?? []
        if (errors.length === 0) {
          cleanedVersions += batch.length
          batchCleaned = true
          break
        }

        // Some succeeded, some failed
        const errorKeyVersionPairs = new Set(
          errors.map((e) => `${e.Key ?? ""}:${e.VersionId ?? ""}`)
        )
        let batchSucceeded = 0
        for (const v of batch) {
          if (!errorKeyVersionPairs.has(`${v.key}:${v.versionId}`)) {
            batchSucceeded += 1
          }
        }
        cleanedVersions += batchSucceeded

        if (attempt === retries) {
          for (const err of errors) {
            failedVersions.push({
              key: err.Key ?? "",
              versionId: err.VersionId ?? "",
              error: err.Message ?? "Delete failed",
            })
          }
        } else {
          await sleep(150 * attempt)
        }
      } catch (error) {
        if (isPermissionStyleS3Error(error)) throw error

        if (attempt === retries) {
          const errorMessage = getS3ErrorMessage(error)
          for (const v of batch) {
            failedVersions.push({
              key: v.key,
              versionId: v.versionId,
              error: errorMessage,
            })
          }
        } else {
          await sleep(150 * attempt)
          continue
        }
      }

      if (batchCleaned) break
    }
  }

  const remaining = await scanNoncurrentVersions(client, bucket, true)

  return {
    attemptedVersions: initialScan.versions.length,
    cleanedVersions,
    failedVersions,
    remaining,
  }
}

export { getS3ErrorCode, getS3ErrorMessage, isPermissionStyleS3Error }
