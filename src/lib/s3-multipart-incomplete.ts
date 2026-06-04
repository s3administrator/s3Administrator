import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  type S3Client,
} from "@aws-sdk/client-s3"

const PAGINATION_PAGE_LIMIT = 10_000
const SCAN_PARTS_CONCURRENCY = 4

interface S3ErrorDetails {
  code: string
  message: string
  status: number | null
}

export interface MultipartUploadRef {
  key: string
  uploadId: string
  initiatedUtc: string | null
}

export interface MultipartPartRef {
  partNumber: number
  size: number
}

export interface MultipartIncompleteUploadDetail {
  key: string
  uploadId: string
  initiatedUtc: string | null
  partCount: number
  size: number
}

export interface MultipartIncompleteSummary {
  uploads: number
  parts: number
  incompleteSize: number
}

export interface MultipartIncompleteScanResult {
  summary: MultipartIncompleteSummary
  uploads: MultipartIncompleteUploadDetail[]
}

export interface MultipartIncompleteScanPageResult {
  pageSummary: MultipartIncompleteSummary
  uploads: MultipartIncompleteUploadDetail[]
  nextKeyMarker: string | null
  nextUploadIdMarker: string | null
  hasMore: boolean
}

export interface MultipartCleanupFailure {
  key: string
  uploadId: string
  error: string
}

export interface MultipartCleanupResult {
  attemptedUploads: number
  cleanedUploads: number
  failedUploads: MultipartCleanupFailure[]
  remaining: MultipartIncompleteScanResult
}

function readS3ErrorDetails(error: unknown): S3ErrorDetails {
  if (!error || typeof error !== "object") {
    return {
      code: "",
      message: "Unknown S3 error",
      status: null,
    }
  }

  const candidate = error as {
    name?: unknown
    code?: unknown
    Code?: unknown
    message?: unknown
    Message?: unknown
    $metadata?: unknown
  }

  const code =
    typeof candidate.Code === "string"
      ? candidate.Code
      : typeof candidate.code === "string"
        ? candidate.code
        : typeof candidate.name === "string"
          ? candidate.name
          : ""

  let status: number | null = null
  if (
    candidate.$metadata &&
    typeof candidate.$metadata === "object" &&
    "httpStatusCode" in candidate.$metadata
  ) {
    const httpStatusCode = (candidate.$metadata as { httpStatusCode?: unknown }).httpStatusCode
    if (typeof httpStatusCode === "number") {
      status = httpStatusCode
    }
  }

  const message =
    typeof candidate.message === "string"
      ? candidate.message
      : typeof candidate.Message === "string"
        ? candidate.Message
        : code
          ? `S3 error: ${code}`
          : "Unknown S3 error"

  return { code, message, status }
}

export function getS3ErrorMessage(error: unknown): string {
  return readS3ErrorDetails(error).message
}

export function getS3ErrorCode(error: unknown): string {
  return readS3ErrorDetails(error).code
}

export function isPermissionStyleS3Error(error: unknown): boolean {
  const details = readS3ErrorDetails(error)
  if (details.status === 401 || details.status === 403) return true
  if (details.code.includes("AccessDenied")) return true
  if (details.code.includes("Unauthorized")) return true
  if (details.code.includes("Forbidden")) return true

  const normalizedMessage = details.message.toLowerCase()
  return (
    normalizedMessage.includes("access denied") ||
    normalizedMessage.includes("permission denied") ||
    normalizedMessage.includes("forbidden") ||
    normalizedMessage.includes("unauthorized")
  )
}

interface ListMultipartUploadsPageParams {
  limit: number
  keyMarker?: string
  uploadIdMarker?: string
}

interface ListMultipartUploadsPageResult {
  uploads: MultipartUploadRef[]
  nextKeyMarker: string | null
  nextUploadIdMarker: string | null
  hasMore: boolean
}

function isMissingUploadError(error: unknown): boolean {
  const details = readS3ErrorDetails(error)
  if (details.status === 404) return true
  if (details.code === "NoSuchUpload") return true
  if (details.code === "NotFound") return true
  if (details.code === "NoSuchKey") return true
  const normalizedMessage = details.message.toLowerCase()
  return (
    normalizedMessage.includes("specified upload does not exist") ||
    normalizedMessage.includes("no such upload")
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function listAllMultipartUploads(
  client: S3Client,
  bucket: string
): Promise<MultipartUploadRef[]> {
  const uploads: MultipartUploadRef[] = []
  let keyMarker: string | undefined
  let uploadIdMarker: string | undefined
  let pageCount = 0

  while (true) {
    pageCount += 1
    if (pageCount > PAGINATION_PAGE_LIMIT) {
      throw new Error("Multipart uploads scan exceeded pagination safety limit")
    }

    const response = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        MaxUploads: 1000,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      })
    )

    for (const upload of response.Uploads ?? []) {
      if (!upload.Key || !upload.UploadId) continue
      uploads.push({
        key: upload.Key,
        uploadId: upload.UploadId,
        initiatedUtc: upload.Initiated?.toISOString() ?? null,
      })
    }

    if (!response.IsTruncated) {
      break
    }

    const nextKeyMarker = response.NextKeyMarker
    const nextUploadIdMarker = response.NextUploadIdMarker

    if (!nextKeyMarker && !nextUploadIdMarker) {
      throw new Error("Multipart uploads pagination stalled (missing cursor)")
    }
    if (nextKeyMarker === keyMarker && nextUploadIdMarker === uploadIdMarker) {
      throw new Error("Multipart uploads pagination stalled (cursor did not advance)")
    }

    keyMarker = nextKeyMarker
    uploadIdMarker = nextUploadIdMarker
  }

  return uploads
}

async function listMultipartUploadsPage(
  client: S3Client,
  bucket: string,
  params: ListMultipartUploadsPageParams
): Promise<ListMultipartUploadsPageResult> {
  const limit = Math.max(1, Math.min(200, Math.trunc(params.limit)))
  const uploads: MultipartUploadRef[] = []
  let keyMarker = params.keyMarker
  let uploadIdMarker = params.uploadIdMarker
  let pageCount = 0

  while (uploads.length < limit) {
    pageCount += 1
    if (pageCount > PAGINATION_PAGE_LIMIT) {
      throw new Error("Multipart uploads page scan exceeded pagination safety limit")
    }

    const response = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        MaxUploads: 1000,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      })
    )

    const responseUploads = response.Uploads ?? []
    for (let index = 0; index < responseUploads.length; index += 1) {
      const upload = responseUploads[index]
      if (!upload?.Key || !upload.UploadId) continue

      uploads.push({
        key: upload.Key,
        uploadId: upload.UploadId,
        initiatedUtc: upload.Initiated?.toISOString() ?? null,
      })

      if (uploads.length >= limit) {
        const remainingInResponse = responseUploads.slice(index + 1).some(
          (candidate) => Boolean(candidate?.Key && candidate.UploadId)
        )
        const hasMore = remainingInResponse || Boolean(response.IsTruncated)
        const lastUpload = uploads[uploads.length - 1]

        return {
          uploads,
          nextKeyMarker: hasMore ? (lastUpload?.key ?? null) : null,
          nextUploadIdMarker: hasMore ? (lastUpload?.uploadId ?? null) : null,
          hasMore,
        }
      }
    }

    if (!response.IsTruncated) {
      return {
        uploads,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
        hasMore: false,
      }
    }

    const nextKeyMarker = response.NextKeyMarker
    const nextUploadIdMarker = response.NextUploadIdMarker
    if (!nextKeyMarker && !nextUploadIdMarker) {
      throw new Error("Multipart uploads pagination stalled (missing cursor)")
    }
    if (nextKeyMarker === keyMarker && nextUploadIdMarker === uploadIdMarker) {
      throw new Error("Multipart uploads pagination stalled (cursor did not advance)")
    }

    keyMarker = nextKeyMarker
    uploadIdMarker = nextUploadIdMarker
  }

  const lastUpload = uploads[uploads.length - 1]
  return {
    uploads,
    nextKeyMarker: lastUpload?.key ?? null,
    nextUploadIdMarker: lastUpload?.uploadId ?? null,
    hasMore: true,
  }
}

export async function listAllPartsForUpload(
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string
): Promise<MultipartPartRef[]> {
  const parts: MultipartPartRef[] = []
  let partNumberMarker: string | undefined
  let pageCount = 0

  while (true) {
    pageCount += 1
    if (pageCount > PAGINATION_PAGE_LIMIT) {
      throw new Error("Multipart parts scan exceeded pagination safety limit")
    }

    const response = await client.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MaxParts: 1000,
        PartNumberMarker: partNumberMarker,
      })
    )

    for (const part of response.Parts ?? []) {
      const partNumber = typeof part.PartNumber === "number"
        ? part.PartNumber
        : typeof part.PartNumber === "string"
          ? Number(part.PartNumber)
          : NaN
      if (!Number.isFinite(partNumber) || partNumber < 1) continue

      const size = typeof part.Size === "number"
        ? part.Size
        : typeof part.Size === "string" || typeof part.Size === "bigint"
          ? Number(part.Size)
          : NaN
      if (!Number.isFinite(size)) continue

      parts.push({
        partNumber,
        size: Math.max(0, size),
      })
    }

    if (!response.IsTruncated) {
      break
    }

    // Some S3-compatible providers return NextPartNumberMarker as a number
    const rawNextMarker = response.NextPartNumberMarker
    const nextMarkerStr =
      typeof rawNextMarker === "string" && rawNextMarker.length > 0
        ? rawNextMarker
        : typeof rawNextMarker === "number"
          ? String(rawNextMarker)
          : ""

    if (!nextMarkerStr) {
      throw new Error("Multipart parts pagination stalled (missing cursor)")
    }
    if (nextMarkerStr === partNumberMarker) {
      throw new Error("Multipart parts pagination stalled (cursor did not advance)")
    }

    const nextMarker = Number(nextMarkerStr)
    if (!Number.isFinite(nextMarker)) {
      throw new Error("Multipart parts pagination stalled (invalid cursor)")
    }

    if (partNumberMarker) {
      const previousMarker = Number(partNumberMarker)
      if (
        Number.isFinite(previousMarker) &&
        nextMarker <= previousMarker
      ) {
        throw new Error("Multipart parts pagination stalled (cursor regressed)")
      }
    }

    partNumberMarker = nextMarkerStr
  }

  return parts
}

export async function scanIncompleteMultipart(
  client: S3Client,
  bucket: string,
  details: boolean
): Promise<MultipartIncompleteScanResult> {
  const listedUploads = await listAllMultipartUploads(client, bucket)

  console.log(
    `[multipart-scan] bucket=${bucket} found ${listedUploads.length} incomplete upload(s)`
  )

  const perUpload: Array<MultipartIncompleteUploadDetail | null> = new Array(
    listedUploads.length
  ).fill(null)

  let skippedMissing = 0
  let nextIndex = 0
  const workerCount = Math.min(SCAN_PARTS_CONCURRENCY, listedUploads.length)

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1

      if (index >= listedUploads.length) {
        break
      }

      const upload = listedUploads[index]
      if (!upload) continue

      let parts: MultipartPartRef[]
      try {
        parts = await listAllPartsForUpload(client, bucket, upload.key, upload.uploadId)
      } catch (error) {
        if (isMissingUploadError(error)) {
          skippedMissing += 1
          continue
        }
        throw error
      }

      const uploadSize = parts.reduce((sum, part) => sum + part.size, 0)
      perUpload[index] = {
        key: upload.key,
        uploadId: upload.uploadId,
        initiatedUtc: upload.initiatedUtc,
        partCount: parts.length,
        size: uploadSize,
      }
    }
  })

  await Promise.all(workers)

  if (skippedMissing > 0) {
    console.log(
      `[multipart-scan] bucket=${bucket} skipped ${skippedMissing} upload(s) (no longer exist)`
    )
  }

  let totalUploads = 0
  let totalParts = 0
  let totalIncompleteSize = 0
  const uploadDetails: MultipartIncompleteUploadDetail[] = []

  for (const item of perUpload) {
    if (!item) continue
    totalUploads += 1
    totalParts += item.partCount
    totalIncompleteSize += item.size
    if (details) {
      uploadDetails.push(item)
    }
  }

  console.log(
    `[multipart-scan] bucket=${bucket} result: ${totalUploads} upload(s), ${totalParts} part(s), ${(totalIncompleteSize / (1024 * 1024)).toFixed(1)} MB total`
  )

  if (details) {
    uploadDetails.sort((a, b) => {
      const aTs = a.initiatedUtc ? Date.parse(a.initiatedUtc) : 0
      const bTs = b.initiatedUtc ? Date.parse(b.initiatedUtc) : 0
      if (aTs !== bTs) {
        return bTs - aTs
      }
      const byKey = a.key.localeCompare(b.key)
      if (byKey !== 0) return byKey
      return a.uploadId.localeCompare(b.uploadId)
    })
  }

  return {
    summary: {
      uploads: totalUploads,
      parts: totalParts,
      incompleteSize: totalIncompleteSize,
    },
    uploads: details ? uploadDetails : [],
  }
}

export async function scanIncompleteMultipartPage(
  client: S3Client,
  bucket: string,
  params: ListMultipartUploadsPageParams
): Promise<MultipartIncompleteScanPageResult> {
  const page = await listMultipartUploadsPage(client, bucket, params)

  const perUpload: Array<MultipartIncompleteUploadDetail | null> = new Array(
    page.uploads.length
  ).fill(null)

  let nextIndex = 0
  const workerCount = Math.min(SCAN_PARTS_CONCURRENCY, page.uploads.length)

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1

      if (index >= page.uploads.length) {
        break
      }

      const upload = page.uploads[index]
      if (!upload) continue

      let parts: MultipartPartRef[]
      try {
        parts = await listAllPartsForUpload(client, bucket, upload.key, upload.uploadId)
      } catch (error) {
        if (isMissingUploadError(error)) {
          continue
        }
        throw error
      }

      perUpload[index] = {
        key: upload.key,
        uploadId: upload.uploadId,
        initiatedUtc: upload.initiatedUtc,
        partCount: parts.length,
        size: parts.reduce((sum, part) => sum + part.size, 0),
      }
    }
  })

  await Promise.all(workers)

  const uploads: MultipartIncompleteUploadDetail[] = []
  let pageUploads = 0
  let pageParts = 0
  let pageIncompleteSize = 0

  for (const item of perUpload) {
    if (!item) continue
    uploads.push(item)
    pageUploads += 1
    pageParts += item.partCount
    pageIncompleteSize += item.size
  }

  uploads.sort((a, b) => {
    const aTs = a.initiatedUtc ? Date.parse(a.initiatedUtc) : 0
    const bTs = b.initiatedUtc ? Date.parse(b.initiatedUtc) : 0
    if (aTs !== bTs) {
      return bTs - aTs
    }
    const byKey = a.key.localeCompare(b.key)
    if (byKey !== 0) return byKey
    return a.uploadId.localeCompare(b.uploadId)
  })

  return {
    pageSummary: {
      uploads: pageUploads,
      parts: pageParts,
      incompleteSize: pageIncompleteSize,
    },
    uploads,
    nextKeyMarker: page.nextKeyMarker,
    nextUploadIdMarker: page.nextUploadIdMarker,
    hasMore: page.hasMore,
  }
}

export async function cleanupIncompleteMultipart(
  client: S3Client,
  bucket: string,
  retryAttempts: number = 3
): Promise<MultipartCleanupResult> {
  const retries = Math.max(1, Math.min(10, Math.trunc(retryAttempts)))
  const initialScan = await scanIncompleteMultipart(client, bucket, true)

  let cleanedUploads = 0
  const failedUploads: MultipartCleanupFailure[] = []

  for (const upload of initialScan.uploads) {
    let cleaned = false
    let lastError = "Failed to cleanup multipart upload"

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: upload.key,
            UploadId: upload.uploadId,
          })
        )
      } catch (error) {
        if (isMissingUploadError(error)) {
          cleaned = true
          break
        }
        if (isPermissionStyleS3Error(error)) {
          throw error
        }
        lastError = getS3ErrorMessage(error)
        if (attempt < retries) {
          await sleep(150 * attempt)
          continue
        }
        break
      }

      try {
        const remainingParts = await listAllPartsForUpload(
          client,
          bucket,
          upload.key,
          upload.uploadId
        )

        if (remainingParts.length === 0) {
          cleaned = true
          break
        }

        lastError = `Upload still has ${remainingParts.length} part${
          remainingParts.length === 1 ? "" : "s"
        } after abort attempt ${attempt}`

        if (attempt < retries) {
          await sleep(150 * attempt)
          continue
        }
      } catch (error) {
        if (isMissingUploadError(error)) {
          cleaned = true
          break
        }
        if (isPermissionStyleS3Error(error)) {
          throw error
        }
        lastError = getS3ErrorMessage(error)
        if (attempt < retries) {
          await sleep(150 * attempt)
          continue
        }
      }
    }

    if (cleaned) {
      cleanedUploads += 1
      continue
    }

    failedUploads.push({
      key: upload.key,
      uploadId: upload.uploadId,
      error: lastError,
    })
  }

  const remaining = await scanIncompleteMultipart(client, bucket, true)

  return {
    attemptedUploads: initialScan.uploads.length,
    cleanedUploads,
    failedUploads,
    remaining,
  }
}
