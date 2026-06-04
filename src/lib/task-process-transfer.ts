import { NextResponse } from "next/server"
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { PassThrough, Transform, type TransformCallback } from "node:stream"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import { getBucketLimitViolation } from "@/lib/plan-limits"
import { logUserAuditAction } from "@/lib/audit-logger"
import { applyUserExtensionStatsDelta, rebuildUserExtensionStats } from "@/lib/file-stats"
import { isDestinationUpToDateForSync } from "@/lib/transfer-delta"
import {
  nextRunAtForTaskSchedule,
  type ResolvedTaskSchedule,
} from "@/lib/task-schedule"
import { type TaskExecutionHistoryEntry } from "@/lib/task-plans"
import {
  getTaskTransferBatchSize,
  getTaskTransferItemConcurrency,
  getTaskTransferMultipartCopyPartConcurrency,
  getTaskTransferProgressMaxEventsPerFile,
  getTaskTransferProgressMinFileSizeMb,
  getTaskTransferProgressSampleDeltaMb,
  getTaskTransferProgressSampleIntervalMs,
  getTaskTransferPreferServerCopySameBackend,
  getTaskTransferRelayPartSizeMb,
  getTaskTransferRelayQueueSize,
  getTaskTransferItemRetryMaxAttempts,
  getTaskTransferItemRetryBaseDelayMs,
  getTaskTransferVerifyChecksum,
  getTaskTransferBandwidthLimitMbps,
  getTaskTransferParallelChunkedDownloadThresholdMb,
  getTaskTransferParallelDownloadStreams,
  getTaskWorkerUserBudgetMs,
} from "@/lib/task-engine-config"
import {
  type ObjectTransferTaskPayload,
  type ObjectTransferTaskProgress,
  type WorkerTaskSnapshot,
  type TransferSourceRow,
  type TransferDestinationSnapshot,
  type TransferMetadataUpsertRow,
  type PreparedTransferItem,
  type TransferItemResult,
  type TransferStrategy,
  type TransferProgressStage,
  type TransferProgressSampleReason,
  type TransferSkipReason,
  type TransferTelemetryHooks,
  type RemoteObjectSnapshot,
  type SyncDestinationDriftRow,
  LOCK_SECONDS,
  SYNC_POLL_INTERVAL_SECONDS,
  ONE_MEBIBYTE_BYTES,
  ONE_MEBIBYTE_BIGINT,
  DEFAULT_MULTIPART_PART_SIZE_BYTES,
  DEFAULT_MULTIPART_PART_SIZE_BIGINT,
  MAX_MULTIPART_PARTS,
  MAX_RELAY_BUFFERED_BYTES,
  SINGLE_REQUEST_COPY_MAX_BYTES,
  TRANSFER_PROGRESS_MILESTONES,
  TRANSIENT_S3_ERROR_CODES,
  parseObjectTransferPayload,
  parseObjectTransferProgress,
  parseProgressBigint,
  mapTransferDestinationKey,
  buildCopySource,
  toValidContentLength,
  bigintToNumberLossy,
  buildDetailedFallbackReason,
  getS3ErrorStatus,
  getS3ErrorMessage,
  getS3ErrorCode,
  isEntityTooLargeError,
  isCopyCompatibilityFallbackError,
  isCopyAuthFallbackError,
  isTransientS3Error,
  isS3MissingObjectError,
  computeRetryDelayMs,
  sleep,
  formatTaskProcessingError,
  formatTransferSkipReason,
  addTaskHistoryEntry,
  buildProcessedResponse,
  snapshotFromCheckpoint,
  persistClaimedTaskCheckpoint,
  refreshTaskLock,
  failTaskTerminal,
  upsertFileMetadataBatch,
  resolveTaskPlanPayload,
  deleteKeysFromBucket,
  emptyTransferProgress,
  reserveRelayMemory,
  releaseRelayMemory,
  AsyncSemaphore,
} from "@/lib/task-process-shared"

export class BandwidthThrottleTransform extends Transform {
  private readonly bytesPerSecond: number
  private tokenBucket: number
  private lastRefillTime: number

  constructor(bytesPerSecond: number) {
    super()
    this.bytesPerSecond = bytesPerSecond
    this.tokenBucket = bytesPerSecond
    this.lastRefillTime = Date.now()
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    void this._throttledWrite(chunk, callback)
  }

  private async _throttledWrite(chunk: Buffer, callback: TransformCallback): Promise<void> {
    let offset = 0
    while (offset < chunk.length) {
      this.refillTokens()
      if (this.tokenBucket <= 0) {
        await sleep(50)
        continue
      }
      const bytesToSend = Math.min(chunk.length - offset, Math.floor(this.tokenBucket))
      this.tokenBucket -= bytesToSend
      this.push(chunk.subarray(offset, offset + bytesToSend))
      offset += bytesToSend
    }
    callback()
  }

  private refillTokens(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefillTime) / 1000
    this.lastRefillTime = now
    this.tokenBucket = Math.min(
      this.bytesPerSecond,
      this.tokenBucket + elapsed * this.bytesPerSecond
    )
  }
}

export function createThrottledStream(
  source: NodeJS.ReadableStream,
  bandwidthLimitMbps: number
): NodeJS.ReadableStream {
  if (bandwidthLimitMbps <= 0) return source
  const bytesPerSecond = bandwidthLimitMbps * 1024 * 1024
  const throttle = new BandwidthThrottleTransform(bytesPerSecond)
  return (source as import("stream").Readable).pipe(throttle)
}

export async function parallelChunkedDownload(params: {
  sourceClient: S3Client
  sourceBucket: string
  sourceKey: string
  totalBytes: bigint
  streams: number
  onProgress?: (downloadedBytes: bigint) => void
}): Promise<NodeJS.ReadableStream> {
  const { sourceClient, sourceBucket, sourceKey, totalBytes, streams } = params
  const chunkSize = totalBytes / BigInt(streams)
  const passThrough = new PassThrough()

  const ranges: Array<{ start: bigint; end: bigint }> = []
  for (let i = 0; i < streams; i++) {
    const start = chunkSize * BigInt(i)
    const end = i === streams - 1 ? totalBytes - BigInt(1) : start + chunkSize - BigInt(1)
    ranges.push({ start, end })
  }

  // Download chunks sequentially and pipe in order to preserve byte order,
  // but fetch the next chunk header concurrently with the current stream.
  void (async () => {
    let totalDownloaded = BigInt(0)
    try {
      for (const range of ranges) {
        const response = await sourceClient.send(
          new GetObjectCommand({
            Bucket: sourceBucket,
            Key: sourceKey,
            Range: `bytes=${range.start.toString()}-${range.end.toString()}`,
          })
        )
        if (!response.Body) {
          throw new Error(`Missing body for range ${range.start}-${range.end}`)
        }
        const readable = response.Body as import("stream").Readable
        await new Promise<void>((resolve, reject) => {
          readable.on("data", (chunk: Buffer) => {
            totalDownloaded += BigInt(chunk.length)
            params.onProgress?.(totalDownloaded)
            if (!passThrough.write(chunk)) {
              readable.pause()
              passThrough.once("drain", () => readable.resume())
            }
          })
          readable.on("end", resolve)
          readable.on("error", reject)
        })
      }
      passThrough.end()
    } catch (error) {
      passThrough.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  return passThrough
}

export function isSameS3Backend(params: {
  sourceEndpoint: string
  destinationEndpoint: string
  sourceRegion: string
  destinationRegion: string
  sourceProvider: string
  destinationProvider: string
}): boolean {
  return (
    params.sourceEndpoint.trim().toLowerCase() === params.destinationEndpoint.trim().toLowerCase() &&
    params.sourceRegion.trim() === params.destinationRegion.trim() &&
    params.sourceProvider.trim().toUpperCase() === params.destinationProvider.trim().toUpperCase()
  )
}

export function selectTransferStrategy(params: {
  sameCredential: boolean
  preferServerCopySameBackend: boolean
  sourceSizeBytes: bigint | null
  sourceEndpoint: string
  destinationEndpoint: string
  sourceRegion: string
  destinationRegion: string
  sourceProvider: string
  destinationProvider: string
}): TransferStrategy {
  const sameBackend = isSameS3Backend({
    sourceEndpoint: params.sourceEndpoint,
    destinationEndpoint: params.destinationEndpoint,
    sourceRegion: params.sourceRegion,
    destinationRegion: params.destinationRegion,
    sourceProvider: params.sourceProvider,
    destinationProvider: params.destinationProvider,
  })
  const canUseServerCopy =
    sameBackend && (params.sameCredential || params.preferServerCopySameBackend)

  if (
    canUseServerCopy
  ) {
    if (params.sourceSizeBytes !== null && params.sourceSizeBytes > SINGLE_REQUEST_COPY_MAX_BYTES) {
      return "multipart_server_copy"
    }
    return "single_request_server_copy"
  }

  return "multipart_relay_upload"
}

export function computeMultipartPartSizeBytes(sourceSizeBytes: bigint): bigint {
  const partCountFloor = (
    sourceSizeBytes + BigInt(MAX_MULTIPART_PARTS) - BigInt(1)
  ) / BigInt(MAX_MULTIPART_PARTS)
  const minimumSize = partCountFloor > DEFAULT_MULTIPART_PART_SIZE_BIGINT
    ? partCountFloor
    : DEFAULT_MULTIPART_PART_SIZE_BIGINT
  return (
    (minimumSize + ONE_MEBIBYTE_BIGINT - BigInt(1)) / ONE_MEBIBYTE_BIGINT
  ) * ONE_MEBIBYTE_BIGINT
}

export async function readSourceObjectHeadDetails(params: {
  sourceClient: S3Client
  sourceBucket: string
  sourceKey: string
  expectedContentLength?: unknown
}): Promise<{
  sizeBytes: bigint | null
  contentType: string | undefined
  cacheControl: string | undefined
}> {
  const response = await params.sourceClient.send(
    new HeadObjectCommand({
      Bucket: params.sourceBucket,
      Key: params.sourceKey,
    })
  )

  const size =
    toValidContentLength(response.ContentLength) ??
    toValidContentLength(params.expectedContentLength)

  return {
    sizeBytes: size === null ? null : BigInt(size),
    contentType: typeof response.ContentType === "string" ? response.ContentType : undefined,
    cacheControl: typeof response.CacheControl === "string" ? response.CacheControl : undefined,
  }
}

export async function readRemoteObjectSnapshot(params: {
  client: S3Client
  bucket: string
  key: string
}): Promise<RemoteObjectSnapshot | null> {
  try {
    const response = await params.client.send(
      new HeadObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
      })
    )

    const size = toValidContentLength(response.ContentLength)
    const lastModified = response.LastModified instanceof Date ? response.LastModified : null

    return {
      size: size === null ? null : BigInt(size),
      lastModified,
    }
  } catch (error) {
    if (isS3MissingObjectError(error)) {
      return null
    }
    throw error
  }
}

export async function copyObjectAcrossLocations(params: {
  sourceClient: S3Client
  destinationClient: S3Client
  sameCredential: boolean
  sourceEndpoint: string
  destinationEndpoint: string
  sourceRegion: string
  destinationRegion: string
  sourceProvider: string
  destinationProvider: string
  sourceBucket: string
  sourceKey: string
  destinationBucket: string
  destinationKey: string
  expectedContentLength?: unknown
  telemetry?: TransferTelemetryHooks
  forceStrategy?: TransferStrategy
  relaySemaphore?: AsyncSemaphore
}) {
  const relayPartSizeBytes = getTaskTransferRelayPartSizeMb() * ONE_MEBIBYTE_BYTES
  const relayQueueSizeConfigured = getTaskTransferRelayQueueSize()
  const relayQueueMemoryCap = Math.max(
    1,
    Math.floor(MAX_RELAY_BUFFERED_BYTES / relayPartSizeBytes)
  )
  const relayQueueSize = Math.max(
    1,
    Math.min(relayQueueSizeConfigured, relayQueueMemoryCap)
  )

  const sourceSizeBytes = (() => {
    const contentLength = toValidContentLength(params.expectedContentLength)
    return contentLength === null ? null : BigInt(contentLength)
  })()

  const initialStrategy = params.forceStrategy ?? selectTransferStrategy({
    sameCredential: params.sameCredential,
    preferServerCopySameBackend: getTaskTransferPreferServerCopySameBackend(),
    sourceSizeBytes,
    sourceEndpoint: params.sourceEndpoint,
    destinationEndpoint: params.destinationEndpoint,
    sourceRegion: params.sourceRegion,
    destinationRegion: params.destinationRegion,
    sourceProvider: params.sourceProvider,
    destinationProvider: params.destinationProvider,
  })

  async function emitStart(strategy: TransferStrategy, totalBytes: bigint | null) {
    if (!params.telemetry?.start) return
    await params.telemetry.start({
      sourceKey: params.sourceKey,
      destinationKey: params.destinationKey,
      strategy,
      totalBytes,
    })
  }

  async function emitProgress(
    strategy: TransferStrategy,
    transferredBytes: bigint,
    totalBytes: bigint | null,
    stage?: TransferProgressStage
  ) {
    if (!params.telemetry?.progress) return
    await params.telemetry.progress({
      sourceKey: params.sourceKey,
      destinationKey: params.destinationKey,
      strategy,
      transferredBytes,
      totalBytes,
      stage,
    })
  }

  async function emitStage(strategy: TransferStrategy | null, stage: TransferProgressStage) {
    if (!params.telemetry?.stage) return
    await params.telemetry.stage({
      sourceKey: params.sourceKey,
      destinationKey: params.destinationKey,
      strategy,
      stage,
    })
  }

  async function emitFallback(reason: string, nextStrategy: TransferStrategy) {
    if (!params.telemetry?.fallback) return
    await params.telemetry.fallback({
      sourceKey: params.sourceKey,
      destinationKey: params.destinationKey,
      reason,
      nextStrategy,
    })
  }

  async function emitFinish(strategy: TransferStrategy | null, status: "completed" | "failed") {
    if (!params.telemetry?.finish) return
    await params.telemetry.finish({
      sourceKey: params.sourceKey,
      destinationKey: params.destinationKey,
      strategy,
      status,
    })
  }

  const copySourceValue = buildCopySource(params.sourceBucket, params.sourceKey)

  function detailedFallback(
    command: string,
    error: unknown,
    nextStrategy: TransferStrategy,
    extraParams?: Record<string, string>
  ): string {
    return buildDetailedFallbackReason({
      action: `${command} failed`,
      command,
      commandParams: {
        Bucket: params.destinationBucket,
        CopySource: copySourceValue,
        Key: params.destinationKey,
        srcBucket: params.sourceBucket,
        srcKey: params.sourceKey,
        ...extraParams,
      },
      error,
      nextStrategy,
    })
  }

  async function multipartRelayObjectAcrossLocations(
    strategy: TransferStrategy = "multipart_relay_upload"
  ): Promise<void> {
    // Serialize relay uploads within a task so only 1 runs at a time.
    // Server-side copy operations are not gated by this semaphore.
    if (params.relaySemaphore) {
      await params.relaySemaphore.acquire()
    }
    try {
      await doMultipartRelay(strategy)
    } finally {
      params.relaySemaphore?.release()
    }
  }

  async function doMultipartRelay(
    strategy: TransferStrategy = "multipart_relay_upload"
  ): Promise<void> {
    // Reserve memory from the global relay budget before buffering.
    // Waits if budget is full instead of failing — other relays finishing
    // will free up space and wake us.
    const reservedBytes = MAX_RELAY_BUFFERED_BYTES
    await reserveRelayMemory(reservedBytes)

    try {
    await emitStage(strategy, "copying")

    const bandwidthLimitMbps = getTaskTransferBandwidthLimitMbps()
    const parallelDownloadThresholdBytes =
      BigInt(getTaskTransferParallelChunkedDownloadThresholdMb()) * ONE_MEBIBYTE_BIGINT
    const parallelDownloadStreams = getTaskTransferParallelDownloadStreams()

    // Determine source size from head or expected content length
    const headDetails = await readSourceObjectHeadDetails({
      sourceClient: params.sourceClient,
      sourceBucket: params.sourceBucket,
      sourceKey: params.sourceKey,
      expectedContentLength: params.expectedContentLength,
    })
    const totalBytes = headDetails.sizeBytes ?? sourceSizeBytes
    const contentLength = totalBytes !== null ? Number(totalBytes) : null

    // Choose download method: parallel chunked for large files, streaming for others
    const useParallelDownload =
      parallelDownloadThresholdBytes > BigInt(0) &&
      totalBytes !== null &&
      totalBytes >= parallelDownloadThresholdBytes &&
      parallelDownloadStreams > 1

    let sourceBody: NodeJS.ReadableStream

    if (useParallelDownload && totalBytes !== null) {
      sourceBody = await parallelChunkedDownload({
        sourceClient: params.sourceClient,
        sourceBucket: params.sourceBucket,
        sourceKey: params.sourceKey,
        totalBytes,
        streams: parallelDownloadStreams,
      })
    } else {
      const sourceObject = await params.sourceClient.send(
        new GetObjectCommand({
          Bucket: params.sourceBucket,
          Key: params.sourceKey,
        })
      )
      if (!sourceObject.Body) {
        throw new Error(`Missing source object body for key '${params.sourceKey}'`)
      }
      sourceBody = sourceObject.Body as unknown as NodeJS.ReadableStream
    }

    // Apply bandwidth throttling if configured
    const throttledBody = createThrottledStream(sourceBody, bandwidthLimitMbps)

    // Start a resumable multipart upload manually so we can track and resume
    const createResponse = await params.destinationClient.send(
      new CreateMultipartUploadCommand({
        Bucket: params.destinationBucket,
        Key: params.destinationKey,
        ...(headDetails.contentType ? { ContentType: headDetails.contentType } : {}),
        ...(headDetails.cacheControl ? { CacheControl: headDetails.cacheControl } : {}),
      })
    )
    const uploadId = createResponse.UploadId
    if (!uploadId) {
      throw new Error(`Failed to start multipart relay upload for key '${params.destinationKey}'`)
    }

    try {
      const partSize = relayPartSizeBytes
      const completedParts: Array<{ ETag: string; PartNumber: number }> = []
      let partNumber = 1
      let uploadedBytes = BigInt(0)

      // Decoupled producer-consumer: the reader continuously drains the source
      // stream into a bounded queue of part-sized buffers, keeping the download
      // connection alive.  The writer pulls from the queue and uploads parts.
      // Without this decoupling, a slow upload part stalls the `for await` loop,
      // the source TCP connection goes idle, and Hetzner aborts it (~60 s).
      const readable = throttledBody as import("stream").Readable
      let chunks: Buffer[] = []
      let chunksLength = 0

      const uploadPart = async (body: Buffer, partNum: number): Promise<void> => {
        const response = await params.destinationClient.send(
          new UploadPartCommand({
            Bucket: params.destinationBucket,
            Key: params.destinationKey,
            UploadId: uploadId,
            PartNumber: partNum,
            Body: body,
            ContentLength: body.length,
          })
        )
        const etag = response.ETag
        if (!etag) {
          throw new Error(`Relay upload part ${partNum} did not return an ETag`)
        }
        completedParts.push({ ETag: etag, PartNumber: partNum })
        uploadedBytes += BigInt(body.length)
        void emitProgress(strategy, uploadedBytes, totalBytes, "copying")
      }

      // Bounded buffer between reader and writer.  Allows the reader to stay
      // ahead by a few parts so the source stream keeps being consumed even
      // when an individual upload part is slow.
      const BUFFER_AHEAD_PARTS = Math.max(2, relayQueueSize)
      const partBuffer: Buffer[] = []
      let readerFinished = false
      let readerErr: unknown = null

      // Simple one-shot async signals for cross-coroutine notification
      let notifyPartReady: (() => void) | null = null
      let notifyBufferSpace: (() => void) | null = null

      function awaitPartReady(): Promise<void> {
        if (partBuffer.length > 0 || readerFinished) return Promise.resolve()
        return new Promise<void>((r) => { notifyPartReady = r })
      }
      function signalPartReady() {
        const fn = notifyPartReady; notifyPartReady = null; fn?.()
      }
      function awaitBufferSpace(): Promise<void> {
        if (partBuffer.length < BUFFER_AHEAD_PARTS) return Promise.resolve()
        return new Promise<void>((r) => { notifyBufferSpace = r })
      }
      function signalBufferSpace() {
        const fn = notifyBufferSpace; notifyBufferSpace = null; fn?.()
      }

      // --- Reader (producer): drain source stream → part-sized buffers ---
      const readerTask = (async () => {
        try {
          for await (const chunk of readable) {
            chunks.push(chunk as Buffer)
            chunksLength += (chunk as Buffer).length

            while (chunksLength >= partSize) {
              await awaitBufferSpace()

              const combined = Buffer.concat(chunks)
              const partBody = combined.subarray(0, partSize)
              const remainder = combined.subarray(partSize)
              chunks = remainder.length > 0 ? [remainder] : []
              chunksLength = remainder.length

              partBuffer.push(Buffer.from(partBody))
              signalPartReady()
            }
          }
          // Push trailing data smaller than partSize as final part
          if (chunksLength > 0) {
            await awaitBufferSpace()
            partBuffer.push(Buffer.concat(chunks))
            chunks = []
            chunksLength = 0
            signalPartReady()
          }
        } catch (err) {
          readerErr = err
        } finally {
          readerFinished = true
          signalPartReady()
        }
      })()

      // --- Writer (consumer): upload parts from the bounded buffer ---
      while (true) {
        await awaitPartReady()
        if (readerErr) throw readerErr
        if (partBuffer.length === 0 && readerFinished) break

        const partBody = partBuffer.shift()!
        signalBufferSpace()
        await uploadPart(partBody, partNumber++)
      }

      await readerTask
      if (readerErr) throw readerErr

      if (completedParts.length === 0) {
        // Edge case: empty file — upload a single empty part
        await uploadPart(Buffer.alloc(0), 1)
      }

      completedParts.sort((a, b) => a.PartNumber - b.PartNumber)

      await emitStage(strategy, "finalizing")
      await params.destinationClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: params.destinationBucket,
          Key: params.destinationKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: completedParts },
        })
      )

      if (totalBytes !== null) {
        await emitProgress(strategy, totalBytes, totalBytes, "finalizing")
      }
    } catch (error) {
      // Abort the multipart upload on failure to avoid orphaned parts
      await params.destinationClient.send(
        new AbortMultipartUploadCommand({
          Bucket: params.destinationBucket,
          Key: params.destinationKey,
          UploadId: uploadId,
        })
      ).catch(() => {})
      throw error
    }
    } finally {
      releaseRelayMemory(reservedBytes)
    }
  }

  async function multipartCopyObjectWithinBackend(
    strategy: TransferStrategy = "multipart_server_copy"
  ): Promise<boolean> {
    await emitStage(strategy, "copying")

    const headDetails = await readSourceObjectHeadDetails({
      sourceClient: params.sourceClient,
      sourceBucket: params.sourceBucket,
      sourceKey: params.sourceKey,
      expectedContentLength: params.expectedContentLength,
    })

    if (!headDetails.sizeBytes || headDetails.sizeBytes <= BigInt(0)) {
      return false
    }
    const sourceSizeForCopy = headDetails.sizeBytes

    const createResponse = await params.destinationClient.send(
      new CreateMultipartUploadCommand({
        Bucket: params.destinationBucket,
        Key: params.destinationKey,
        ...(headDetails.contentType ? { ContentType: headDetails.contentType } : {}),
        ...(headDetails.cacheControl ? { CacheControl: headDetails.cacheControl } : {}),
      })
    )

    const uploadId = createResponse.UploadId
    if (!uploadId) {
      throw new Error(`Failed to start multipart copy for key '${params.destinationKey}'`)
    }

    const partSizeBytes = computeMultipartPartSizeBytes(sourceSizeForCopy)
    const copySourceHeader = copySourceValue
    const partRanges: Array<{ partNumber: number; rangeStart: bigint; rangeEnd: bigint }> = []
    let offset = BigInt(0)
    let partNumber = 1
    while (offset < sourceSizeForCopy) {
      const nextOffset = offset + partSizeBytes < sourceSizeForCopy
        ? offset + partSizeBytes
        : sourceSizeForCopy
      const rangeEnd = nextOffset - BigInt(1)
      partRanges.push({
        partNumber,
        rangeStart: offset,
        rangeEnd,
      })
      offset = nextOffset
      partNumber += 1
    }

    if (partRanges.length === 0) {
      return false
    }

    try {
      const concurrency = Math.max(
        1,
        Math.min(getTaskTransferMultipartCopyPartConcurrency(), partRanges.length)
      )
      let copiedBytes = BigInt(0)
      const partResults: Array<{ ETag: string; PartNumber: number } | null> = new Array(
        partRanges.length
      ).fill(null)
      let nextPartIndex = 0
      let firstError: unknown = null

      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          if (firstError) return

          const currentIndex = nextPartIndex
          nextPartIndex += 1
          if (currentIndex >= partRanges.length) {
            return
          }

          const currentPart = partRanges[currentIndex]
          try {
            const partResponse = await params.destinationClient.send(
              new UploadPartCopyCommand({
                Bucket: params.destinationBucket,
                Key: params.destinationKey,
                UploadId: uploadId,
                PartNumber: currentPart.partNumber,
                CopySource: copySourceHeader,
                CopySourceRange:
                  `bytes=${currentPart.rangeStart.toString()}-${currentPart.rangeEnd.toString()}`,
              })
            )

            const etag = partResponse.CopyPartResult?.ETag
            if (!etag) {
              throw new Error(
                `Multipart copy part ${currentPart.partNumber} did not return an ETag for key '${params.destinationKey}'`
              )
            }

            partResults[currentIndex] = {
              ETag: etag,
              PartNumber: currentPart.partNumber,
            }

            copiedBytes += currentPart.rangeEnd - currentPart.rangeStart + BigInt(1)
            await emitProgress(
              strategy,
              copiedBytes > sourceSizeForCopy ? sourceSizeForCopy : copiedBytes,
              sourceSizeForCopy,
              "copying"
            )
          } catch (error) {
            if (!firstError) {
              firstError = error
            }
            return
          }
        }
      })

      await Promise.all(workers)
      if (firstError) {
        throw firstError
      }

      const completedParts = partResults
        .filter((value): value is { ETag: string; PartNumber: number } => Boolean(value))
        .sort((a, b) => a.PartNumber - b.PartNumber)
      if (completedParts.length !== partRanges.length) {
        throw new Error(
          `Multipart copy did not produce all parts for key '${params.destinationKey}'`
        )
      }

      await emitStage(strategy, "finalizing")
      await params.destinationClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: params.destinationBucket,
          Key: params.destinationKey,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: completedParts,
          },
        })
      )

      return true
    } catch (error) {
      await params.destinationClient.send(
        new AbortMultipartUploadCommand({
          Bucket: params.destinationBucket,
          Key: params.destinationKey,
          UploadId: uploadId,
        })
      ).catch(() => {})
      throw error
    }
  }

  async function verifyPostCopyIntegrity(): Promise<void> {
    if (!getTaskTransferVerifyChecksum()) return
    if (sourceSizeBytes === null) return

    const destSnapshot = await readRemoteObjectSnapshot({
      client: params.destinationClient,
      bucket: params.destinationBucket,
      key: params.destinationKey,
    })

    if (!destSnapshot) {
      throw new Error(
        `Post-copy verification failed: destination object '${params.destinationKey}' not found`
      )
    }

    if (destSnapshot.size !== null && destSnapshot.size !== sourceSizeBytes) {
      throw new Error(
        `Post-copy verification failed: size mismatch for '${params.destinationKey}' ` +
        `(source=${sourceSizeBytes.toString()}, destination=${destSnapshot.size.toString()})`
      )
    }
  }

  const complete = async (strategy: TransferStrategy) => {
    await verifyPostCopyIntegrity()
    await emitStage(strategy, "completed")
    await emitFinish(strategy, "completed")
  }

  try {
    await emitStart(initialStrategy, sourceSizeBytes)
    await emitStage(initialStrategy, "queued")

    if (initialStrategy === "multipart_server_copy") {
      try {
        const copied = await multipartCopyObjectWithinBackend("multipart_server_copy")
        if (copied) {
          await complete("multipart_server_copy")
          return
        }

        await emitFallback(
          "multipart_server_copy produced no copyable byte ranges",
          "multipart_relay_upload"
        )
        await multipartRelayObjectAcrossLocations("multipart_relay_upload")
        await complete("multipart_relay_upload")
        return
      } catch (error) {
        if (
          isCopyCompatibilityFallbackError(error) ||
          isCopyAuthFallbackError(error) ||
          isS3MissingObjectError(error)
        ) {
          // Some S3-compatible providers can return NoSuchKey for CopySource
          // parsing issues even when the source exists. Relay upload avoids
          // CopySource and still preserves true missing-source behavior.
          await emitFallback(
            detailedFallback("UploadPartCopy", error, "multipart_relay_upload"),
            "multipart_relay_upload"
          )
          await multipartRelayObjectAcrossLocations("multipart_relay_upload")
          await complete("multipart_relay_upload")
          return
        }
        throw error
      }
    }

    if (initialStrategy === "single_request_server_copy") {
      try {
        await emitStage("single_request_server_copy", "copying")
        await params.destinationClient.send(
          new CopyObjectCommand({
            Bucket: params.destinationBucket,
            CopySource: copySourceValue,
            Key: params.destinationKey,
          })
        )
        if (sourceSizeBytes !== null) {
          await emitProgress(
            "single_request_server_copy",
            sourceSizeBytes,
            sourceSizeBytes,
            "finalizing"
          )
        }
        await complete("single_request_server_copy")
        return
      } catch (error) {
        if (isEntityTooLargeError(error)) {
          await emitFallback(
            detailedFallback("CopyObject", error, "multipart_server_copy"),
            "multipart_server_copy"
          )
          try {
            const copied = await multipartCopyObjectWithinBackend("multipart_server_copy")
            if (copied) {
              await complete("multipart_server_copy")
              return
            }
          } catch (multipartError) {
            if (
              isCopyCompatibilityFallbackError(multipartError) ||
              isCopyAuthFallbackError(multipartError) ||
              isS3MissingObjectError(multipartError)
            ) {
              await emitFallback(
                detailedFallback("UploadPartCopy", multipartError, "multipart_relay_upload"),
                "multipart_relay_upload"
              )
              await multipartRelayObjectAcrossLocations("multipart_relay_upload")
              await complete("multipart_relay_upload")
              return
            }
            throw multipartError
          }

          await emitFallback(
            detailedFallback("UploadPartCopy", new Error("no copyable byte ranges"), "multipart_relay_upload"),
            "multipart_relay_upload"
          )
          await multipartRelayObjectAcrossLocations("multipart_relay_upload")
          await complete("multipart_relay_upload")
          return
        }

        if (isCopyCompatibilityFallbackError(error) || isCopyAuthFallbackError(error)) {
          // Try multipart server copy first — UploadPartCopy often works
          // when CopyObject fails on some S3-compatible providers.
          await emitFallback(
            detailedFallback("CopyObject", error, "multipart_server_copy"),
            "multipart_server_copy"
          )
          try {
            const copied = await multipartCopyObjectWithinBackend("multipart_server_copy")
            if (copied) {
              await complete("multipart_server_copy")
              return
            }
          } catch (multipartError) {
            if (
              isCopyCompatibilityFallbackError(multipartError) ||
              isCopyAuthFallbackError(multipartError) ||
              isS3MissingObjectError(multipartError)
            ) {
              await emitFallback(
                detailedFallback("UploadPartCopy", multipartError, "multipart_relay_upload"),
                "multipart_relay_upload"
              )
              await multipartRelayObjectAcrossLocations("multipart_relay_upload")
              await complete("multipart_relay_upload")
              return
            }
            throw multipartError
          }

          await emitFallback(
            detailedFallback("UploadPartCopy", new Error("no copyable byte ranges"), "multipart_relay_upload"),
            "multipart_relay_upload"
          )
          await multipartRelayObjectAcrossLocations("multipart_relay_upload")
          await complete("multipart_relay_upload")
          return
        }

        if (isS3MissingObjectError(error)) {
          // Try multipart server copy first — some providers return
          // NoSuchKey for CopySource parsing issues that UploadPartCopy handles.
          await emitFallback(
            detailedFallback("CopyObject", error, "multipart_server_copy"),
            "multipart_server_copy"
          )
          try {
            const copied = await multipartCopyObjectWithinBackend("multipart_server_copy")
            if (copied) {
              await complete("multipart_server_copy")
              return
            }
          } catch (multipartError) {
            if (
              isCopyCompatibilityFallbackError(multipartError) ||
              isCopyAuthFallbackError(multipartError) ||
              isS3MissingObjectError(multipartError)
            ) {
              await emitFallback(
                detailedFallback("UploadPartCopy", multipartError, "multipart_relay_upload"),
                "multipart_relay_upload"
              )
              await multipartRelayObjectAcrossLocations("multipart_relay_upload")
              await complete("multipart_relay_upload")
              return
            }
            throw multipartError
          }

          await emitFallback(
            detailedFallback("UploadPartCopy", new Error("no copyable byte ranges"), "multipart_relay_upload"),
            "multipart_relay_upload"
          )
          await multipartRelayObjectAcrossLocations("multipart_relay_upload")
          await complete("multipart_relay_upload")
          return
        }

        throw error
      }
    }

    await multipartRelayObjectAcrossLocations("multipart_relay_upload")
    await complete("multipart_relay_upload")
  } catch (error) {
    await emitStage(null, "failed")
    await emitFinish(null, "failed")
    throw error
  }
}

export async function findSyncDestinationDriftBatch(params: {
  userId: string
  payload: ObjectTransferTaskPayload
}): Promise<SyncDestinationDriftRow[]> {
  const { userId, payload } = params
  const limit = getTaskTransferBatchSize()

  if (payload.scope === "bucket") {
    return prisma.$queryRaw<SyncDestinationDriftRow[]>(Prisma.sql`
      SELECT d."key"
      FROM "FileMetadata" d
      WHERE d."userId" = ${userId}
        AND d."credentialId" = ${payload.destinationCredentialId}
        AND d."bucket" = ${payload.destinationBucket}
        AND d."isFolder" = false
        AND NOT EXISTS (
          SELECT 1
          FROM "FileMetadata" s
          WHERE s."userId" = ${userId}
            AND s."credentialId" = ${payload.sourceCredentialId}
            AND s."bucket" = ${payload.sourceBucket}
            AND s."isFolder" = false
            AND s."key" = d."key"
        )
      ORDER BY d."key" ASC
      LIMIT ${limit}
    `)
  }

  const sourcePrefix = payload.sourcePrefix ?? ""
  const destinationPrefix = payload.destinationPrefix ?? ""
  const destinationPrefixLength = destinationPrefix.length
  const substringStart = destinationPrefixLength + 1

  return prisma.$queryRaw<SyncDestinationDriftRow[]>(Prisma.sql`
    SELECT d."key"
    FROM "FileMetadata" d
    WHERE d."userId" = ${userId}
      AND d."credentialId" = ${payload.destinationCredentialId}
      AND d."bucket" = ${payload.destinationBucket}
      AND d."isFolder" = false
      AND LEFT(d."key", ${destinationPrefixLength}) = ${destinationPrefix}
      AND NOT EXISTS (
        SELECT 1
        FROM "FileMetadata" s
        WHERE s."userId" = ${userId}
          AND s."credentialId" = ${payload.sourceCredentialId}
          AND s."bucket" = ${payload.sourceBucket}
          AND s."isFolder" = false
          AND s."key" = ${sourcePrefix} || substring(d."key" from ${substringStart})
        )
    ORDER BY d."key" ASC
    LIMIT ${limit}
  `)
}

export async function cleanupSyncDestinationDrift(params: {
  userId: string
  payload: ObjectTransferTaskPayload
  destinationClient: S3Client
}): Promise<{ deleted: number; failed: number }> {
  const { userId, payload, destinationClient } = params
  let deleted = 0
  let failed = 0

  while (true) {
    const driftRows = await findSyncDestinationDriftBatch({ userId, payload })
    if (driftRows.length === 0) {
      break
    }

    const driftKeys = driftRows.map((row) => row.key)
    const deletedKeys = await deleteKeysFromBucket(
      destinationClient,
      payload.destinationBucket,
      driftKeys
    )
    if (deletedKeys.size === 0) {
      failed += driftKeys.length
      break
    }

    const deletedKeyList = Array.from(deletedKeys)
    await prisma.fileMetadata.deleteMany({
      where: {
        userId,
        credentialId: payload.destinationCredentialId,
        bucket: payload.destinationBucket,
        key: { in: deletedKeyList },
      },
    })
    deleted += deletedKeyList.length
    failed += Math.max(0, driftKeys.length - deletedKeys.size)
  }

  return { deleted, failed }
}

export interface ProcessObjectTransferParams {
  candidate: {
    id: string
    type: string
    runCount: number
    attempts: number
    maxAttempts: number
    progress: unknown
    executionPlan: unknown
    payload: unknown
    lastError: string | null
    startedAt: Date | null
    isRecurring: boolean
  }
  actorUserId: string
  claimedTaskSchedule: ResolvedTaskSchedule | null
  taskExecutionHistory: TaskExecutionHistoryEntry[]
}

export async function processObjectTransferTask(
  params: ProcessObjectTransferParams
): Promise<NextResponse> {
  const { candidate, actorUserId, claimedTaskSchedule, taskExecutionHistory } = params

  let transferPayload: ObjectTransferTaskPayload | null = null

  const planPayload = resolveTaskPlanPayload(candidate.executionPlan, candidate.payload)
  transferPayload = parseObjectTransferPayload(planPayload)
  if (!transferPayload) {
    return failTaskTerminal({
      candidate, actorUserId, taskExecutionHistory,
      errorMessage: "Invalid object transfer payload",
      extraResponseBody: { type: "object_transfer" },
    })
  }

  const entitlements = await getUserPlanEntitlements(actorUserId)
  if (!entitlements) {
    return failTaskTerminal({
      candidate, actorUserId, taskExecutionHistory,
      errorMessage: "Failed to resolve plan entitlements",
      extraResponseBody: { type: "object_transfer" },
    })
  }

  const activeTransferPayload = transferPayload
  const destinationContextChanged =
    activeTransferPayload.sourceCredentialId !== activeTransferPayload.destinationCredentialId ||
    activeTransferPayload.sourceBucket !== activeTransferPayload.destinationBucket
  if (destinationContextChanged) {
    const bucketLimitViolation = await getBucketLimitViolation({
      userId: actorUserId,
      credentialId: activeTransferPayload.destinationCredentialId,
      bucket: activeTransferPayload.destinationBucket,
      entitlements,
    })
    if (bucketLimitViolation) {
      return failTaskTerminal({
        candidate, actorUserId, taskExecutionHistory,
        errorMessage: "Bucket limit reached for current plan",
        extraResponseBody: {
          type: "object_transfer",
          skipped: "bucket_limit_reached",
          details: bucketLimitViolation,
        },
      })
    }
  }

  const progress = parseObjectTransferProgress(candidate.progress)
  const sourceScopeBaseWhere = {
    userId: actorUserId,
    credentialId: activeTransferPayload.sourceCredentialId,
    bucket: activeTransferPayload.sourceBucket,
    isFolder: false,
    ...(activeTransferPayload.scope === "folder" && activeTransferPayload.sourcePrefix
      ? { key: { startsWith: activeTransferPayload.sourcePrefix } }
      : {}),
  }
  const sourceKeyFilter: { startsWith?: string; gt?: string } = {}
  if (activeTransferPayload.scope === "folder" && activeTransferPayload.sourcePrefix) {
    sourceKeyFilter.startsWith = activeTransferPayload.sourcePrefix
  }
  if (progress.cursorKey) {
    sourceKeyFilter.gt = progress.cursorKey
  }

  const persistedEstimatedBytes = parseProgressBigint(progress.bytesEstimatedTotal)
  const sourceEstimatedBytesAggregate =
    persistedEstimatedBytes === null
      ? await prisma.fileMetadata.aggregate({
        where: sourceScopeBaseWhere,
        _sum: {
          size: true,
        },
      })
      : null
  const bytesEstimatedTotal =
    persistedEstimatedBytes ?? sourceEstimatedBytesAggregate?._sum.size ?? null
  let bytesProcessedCompleted = parseProgressBigint(progress.bytesProcessedTotal) ?? BigInt(0)
  if (bytesEstimatedTotal !== null && bytesProcessedCompleted > bytesEstimatedTotal) {
    bytesProcessedCompleted = bytesEstimatedTotal
  }

  const [sourceClientInfo, destinationClientInfo] = await Promise.all([
    getS3Client(actorUserId, activeTransferPayload.sourceCredentialId, {
      trafficClass: "background",
    }),
    getS3Client(actorUserId, activeTransferPayload.destinationCredentialId, {
      trafficClass: "background",
    }),
  ])
  const sourceClient = sourceClientInfo.client
  const destinationClient = destinationClientInfo.client

  const sameCredential =
    activeTransferPayload.sourceCredentialId === activeTransferPayload.destinationCredentialId
  const requiresDestinationComparison =
    activeTransferPayload.operation === "copy" || activeTransferPayload.operation === "sync"

  let remainingCacheSlots: number | null = null
  if (
    activeTransferPayload.operation === "copy" ||
    activeTransferPayload.operation === "sync"
  ) {
    if (Number.isFinite(entitlements.fileLimit)) {
      const currentCachedFileCount = await prisma.fileMetadata.count({
        where: {
          userId: actorUserId,
          isFolder: false,
        },
      })
      remainingCacheSlots = Math.max(0, entitlements.fileLimit - currentCachedFileCount)
    }
  }

  const batchSize = getTaskTransferBatchSize()
  let sourceBatch = await prisma.fileMetadata.findMany({
    where: {
      userId: actorUserId,
      credentialId: activeTransferPayload.sourceCredentialId,
      bucket: activeTransferPayload.sourceBucket,
      isFolder: false,
      ...(Object.keys(sourceKeyFilter).length > 0 ? { key: sourceKeyFilter } : {}),
    },
    orderBy: { key: "asc" },
    take: batchSize,
    select: {
      id: true,
      key: true,
      extension: true,
      size: true,
      lastModified: true,
    },
  })

  const sourceTotal =
    progress.total > 0
      ? progress.total
      : progress.processed + await prisma.fileMetadata.count({
        where: {
          userId: actorUserId,
          credentialId: activeTransferPayload.sourceCredentialId,
          bucket: activeTransferPayload.sourceBucket,
          isFolder: false,
          ...(Object.keys(sourceKeyFilter).length > 0 ? { key: sourceKeyFilter } : {}),
        },
      })

  if (sourceBatch.length === 0) {
    const total = sourceTotal
    let syncCleanupDeleted = 0
    let syncCleanupFailed = 0

    if (activeTransferPayload.operation === "sync") {
      const cleanupResult = await cleanupSyncDestinationDrift({
        userId: actorUserId,
        payload: activeTransferPayload,
        destinationClient,
      })
      syncCleanupDeleted = cleanupResult.deleted
      syncCleanupFailed = cleanupResult.failed
    }

    await rebuildUserExtensionStats(actorUserId)

    const cycleProgress = {
      total,
      processed: progress.processed,
      copied: progress.copied,
      moved: progress.moved,
      deleted: progress.deleted + syncCleanupDeleted,
      skipped: progress.skipped,
      failed: progress.failed + syncCleanupFailed,
    }

    if (claimedTaskSchedule?.enabled) {
      const nextRunAt =
        nextRunAtForTaskSchedule(claimedTaskSchedule, new Date()) ??
        new Date(Date.now() + SYNC_POLL_INTERVAL_SECONDS * 1000)
      const scheduledCycleCheckpoint = await persistClaimedTaskCheckpoint({
        taskId: candidate.id,
        userId: actorUserId,
        claimedRunCount: candidate.runCount + 1,
        normalUpdate: {
          status: "pending",
          attempts: 0,
          completedAt: null,
          nextRunAt,
          lastRunAt: new Date(),
          progress: emptyTransferProgress() as unknown as Prisma.InputJsonObject,
          lastError: null,
          executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
            status: cycleProgress.failed > 0 ? "failed" : "succeeded",
            message:
              cycleProgress.failed > 0
                ? "Scheduled cycle completed with failures"
                : "Scheduled cycle completed",
            metadata: {
              nextRunAt: nextRunAt.toISOString(),
              schedule: claimedTaskSchedule.cron ?? claimedTaskSchedule.legacyIntervalSeconds,
              progress: cycleProgress,
            },
          }),
        },
      })

      await logUserAuditAction({
        userId: actorUserId,
        eventType: "s3_action",
        eventName: "object_transfer_scheduled_cycle_completed",
        path: "/api/tasks/process",
        method: "POST",
        target: `${activeTransferPayload.sourceBucket} -> ${activeTransferPayload.destinationBucket}`,
        metadata: {
          scope: activeTransferPayload.scope,
          operation: activeTransferPayload.operation,
          sourceCredentialId: activeTransferPayload.sourceCredentialId,
          sourceBucket: activeTransferPayload.sourceBucket,
          sourcePrefix: activeTransferPayload.sourcePrefix,
          destinationCredentialId: activeTransferPayload.destinationCredentialId,
          destinationBucket: activeTransferPayload.destinationBucket,
          destinationPrefix: activeTransferPayload.destinationPrefix,
          nextRunAt: nextRunAt.toISOString(),
          schedule: claimedTaskSchedule.cron ?? claimedTaskSchedule.legacyIntervalSeconds,
          progress: cycleProgress,
          cleanupDeleted: syncCleanupDeleted,
          cleanupFailed: syncCleanupFailed,
        },
      })

      return buildProcessedResponse(
        snapshotFromCheckpoint(candidate, actorUserId, scheduledCycleCheckpoint),
        {
          done: scheduledCycleCheckpoint.appliedMode === "canceled",
          type: "object_transfer",
          recurring: scheduledCycleCheckpoint.appliedMode === "normal",
          nextRunAt:
            scheduledCycleCheckpoint.appliedMode === "normal"
              ? nextRunAt.toISOString()
              : undefined,
          deletedInCleanup: syncCleanupDeleted,
          failedInCleanup: syncCleanupFailed,
        }
      )
    }

    const hasTransferFailures = cycleProgress.failed > 0
    const finalTransferError = hasTransferFailures
      ? candidate.lastError ?? "One or more objects failed during transfer"
      : null

    const finalTransferCheckpoint = await persistClaimedTaskCheckpoint({
      taskId: candidate.id,
      userId: actorUserId,
      claimedRunCount: candidate.runCount + 1,
      preferTerminal: true,
      normalUpdate: {
        status: hasTransferFailures ? "failed" : "completed",
        lifecycleState: "active",
        attempts: 0,
        completedAt: new Date(),
        nextRunAt: new Date(),
        progress: {
          ...cycleProgress,
          total,
          remaining: 0,
          cursorKey: null,
          currentFileKey: null,
          currentFileSizeBytes: null,
          currentFileTransferredBytes: null,
          currentFileStage: null,
          transferStrategy: null,
          fallbackReason: null,
          bytesProcessedTotal: bytesProcessedCompleted.toString(),
          bytesEstimatedTotal: bytesEstimatedTotal?.toString() ?? null,
          throughputBytesPerSec: null,
          etaSeconds: null,
          lastProgressAt: null,
        } as Prisma.InputJsonObject,
        lastError: finalTransferError,
        executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
          status: hasTransferFailures ? "failed" : "succeeded",
          message: hasTransferFailures
            ? "Transfer completed with failures"
            : "Transfer completed",
          metadata: {
            total,
            processed: cycleProgress.processed,
            copied: cycleProgress.copied,
            moved: cycleProgress.moved,
            deleted: cycleProgress.deleted,
            skipped: cycleProgress.skipped,
            failed: cycleProgress.failed,
          },
        }),
      },
    })

    await logUserAuditAction({
      userId: actorUserId,
      eventType: "s3_action",
      eventName: hasTransferFailures
        ? "object_transfer_failed"
        : "object_transfer_completed",
      path: "/api/tasks/process",
      method: "POST",
      target: `${activeTransferPayload.sourceBucket} -> ${activeTransferPayload.destinationBucket}`,
      metadata: {
        scope: activeTransferPayload.scope,
        operation: activeTransferPayload.operation,
        sourceCredentialId: activeTransferPayload.sourceCredentialId,
        sourceBucket: activeTransferPayload.sourceBucket,
        sourcePrefix: activeTransferPayload.sourcePrefix,
        destinationCredentialId: activeTransferPayload.destinationCredentialId,
        destinationBucket: activeTransferPayload.destinationBucket,
        destinationPrefix: activeTransferPayload.destinationPrefix,
        progress: {
          total,
          processed: progress.processed,
          copied: progress.copied,
          moved: progress.moved,
          deleted: progress.deleted,
          skipped: progress.skipped,
          failed: progress.failed,
        },
      },
    })

    return buildProcessedResponse(
      snapshotFromCheckpoint(candidate, actorUserId, finalTransferCheckpoint, {
        lastError: finalTransferError,
      }),
      {
        done: true,
        type: "object_transfer",
        failed: hasTransferFailures,
      }
    )
  }

  let mappedBatch = sourceBatch.map((sourceFile) => ({
    sourceFile,
    destinationKey: mapTransferDestinationKey(
      activeTransferPayload,
      sourceFile.key
    ),
  }))

  let destinationByKey = new Map<string, TransferDestinationSnapshot>()
  if (requiresDestinationComparison) {
    const destinationRows = await prisma.fileMetadata.findMany({
      where: {
        userId: actorUserId,
        credentialId: activeTransferPayload.destinationCredentialId,
        bucket: activeTransferPayload.destinationBucket,
        isFolder: false,
        key: { in: mappedBatch.map((item) => item.destinationKey) },
      },
      select: {
        key: true,
        size: true,
        lastModified: true,
      },
    })

    destinationByKey = new Map(
      destinationRows.map((row) => [
        row.key,
        {
          size: row.size,
          lastModified: row.lastModified,
        },
      ])
    )
  }

  // Bulk-skip: split the batch into files skippable from cached metadata
  // vs files that need actual transfer processing. Skippable files are
  // counted immediately so we never iterate through them in the loop.
  let bulkSkipReasons: Record<string, number> = {}
  let actionableBatch: typeof mappedBatch = []
  for (const item of mappedBatch) {
    let skipReason: TransferSkipReason | null = null

    if (
      sameCredential &&
      activeTransferPayload.sourceBucket === activeTransferPayload.destinationBucket &&
      item.sourceFile.key === item.destinationKey
    ) {
      skipReason = "same_source_and_destination"
    } else if (requiresDestinationComparison) {
      const dest = destinationByKey.get(item.destinationKey)
      if (dest) {
        if (activeTransferPayload.operation === "copy") {
          skipReason = "already_exists"
        } else if (
          activeTransferPayload.operation === "sync" &&
          isDestinationUpToDateForSync(
            { size: item.sourceFile.size, lastModified: item.sourceFile.lastModified },
            dest
          )
        ) {
          skipReason = "up_to_date"
        }
      }
    }

    if (skipReason) {
      bulkSkipReasons[skipReason] = (bulkSkipReasons[skipReason] ?? 0) + 1
    } else {
      actionableBatch.push(item)
    }
  }

  let bulkSkippedCount = Object.values(bulkSkipReasons).reduce((a, b) => a + b, 0)

  // Emit a single summary event for all bulk-skipped files
  if (bulkSkippedCount > 0) {
    const reasonParts = Object.entries(bulkSkipReasons)
      .map(([reason, count]) => `${count} ${formatTransferSkipReason(reason as TransferSkipReason)}`)
      .join(", ")
    try {
      await prisma.backgroundTaskEvent.create({
        data: {
          taskId: candidate.id,
          userId: actorUserId,
          eventType: "batch_skipped",
          message: `Skipped ${bulkSkippedCount} files (${reasonParts})`,
          metadata: {
            count: bulkSkippedCount,
            reasons: bulkSkipReasons,
          },
        },
      })
    } catch {
      // Non-critical
    }
  }

  // Fast-forward: when the entire batch was bulk-skipped, load subsequent
  // batches immediately instead of returning to the worker poll loop.
  // This avoids wasting one HTTP round-trip per skip-only batch.
  while (
    actionableBatch.length === 0 &&
    sourceBatch.length >= batchSize
  ) {
    // Advance progress past the skipped batch
    const lastSkippedKey = mappedBatch[mappedBatch.length - 1]!.sourceFile.key
    progress.processed += bulkSkippedCount
    progress.skipped += bulkSkippedCount
    progress.cursorKey = lastSkippedKey
    progress.remaining = Math.max(0, sourceTotal - progress.processed)
    sourceKeyFilter.gt = lastSkippedKey

    // Persist checkpoint so the UI reflects progress and cancel/pause is honoured
    const ffCheckpoint = await persistClaimedTaskCheckpoint({
      taskId: candidate.id,
      userId: actorUserId,
      claimedRunCount: candidate.runCount + 1,
      normalUpdate: {
        status: "in_progress",
        attempts: 0,
        nextRunAt: new Date(Date.now() + LOCK_SECONDS * 1000),
        progress: progress as unknown as Prisma.InputJsonObject,
        lastError: null,
        completedAt: null,
      },
    })
    if (ffCheckpoint.appliedMode !== "normal") {
      return buildProcessedResponse(
        snapshotFromCheckpoint(candidate, actorUserId, ffCheckpoint),
        {
          done: true,
          type: "object_transfer",
          processedInBatch: bulkSkippedCount,
          copiedInBatch: 0,
          movedInBatch: 0,
          skippedInBatch: bulkSkippedCount,
          failedInBatch: 0,
          timeBudgetReached: false,
        }
      )
    }

    // Load next batch
    sourceBatch = await prisma.fileMetadata.findMany({
      where: {
        userId: actorUserId,
        credentialId: activeTransferPayload.sourceCredentialId,
        bucket: activeTransferPayload.sourceBucket,
        isFolder: false,
        ...(Object.keys(sourceKeyFilter).length > 0 ? { key: sourceKeyFilter } : {}),
      },
      orderBy: { key: "asc" },
      take: batchSize,
      select: {
        id: true,
        key: true,
        extension: true,
        size: true,
        lastModified: true,
      },
    })

    if (sourceBatch.length === 0) break

    // Rebuild mapped batch and destination metadata
    mappedBatch = sourceBatch.map((sourceFile) => ({
      sourceFile,
      destinationKey: mapTransferDestinationKey(activeTransferPayload, sourceFile.key),
    }))

    if (requiresDestinationComparison) {
      const destinationRows = await prisma.fileMetadata.findMany({
        where: {
          userId: actorUserId,
          credentialId: activeTransferPayload.destinationCredentialId,
          bucket: activeTransferPayload.destinationBucket,
          isFolder: false,
          key: { in: mappedBatch.map((item) => item.destinationKey) },
        },
        select: {
          key: true,
          size: true,
          lastModified: true,
        },
      })
      destinationByKey = new Map(
        destinationRows.map((row) => [
          row.key,
          { size: row.size, lastModified: row.lastModified },
        ])
      )
    }

    // Re-run bulk-skip on the new batch
    bulkSkipReasons = {}
    actionableBatch = []
    for (const item of mappedBatch) {
      let skipReason: TransferSkipReason | null = null

      if (
        sameCredential &&
        activeTransferPayload.sourceBucket === activeTransferPayload.destinationBucket &&
        item.sourceFile.key === item.destinationKey
      ) {
        skipReason = "same_source_and_destination"
      } else if (requiresDestinationComparison) {
        const dest = destinationByKey.get(item.destinationKey)
        if (dest) {
          if (activeTransferPayload.operation === "copy") {
            skipReason = "already_exists"
          } else if (
            activeTransferPayload.operation === "sync" &&
            isDestinationUpToDateForSync(
              { size: item.sourceFile.size, lastModified: item.sourceFile.lastModified },
              dest
            )
          ) {
            skipReason = "up_to_date"
          }
        }
      }

      if (skipReason) {
        bulkSkipReasons[skipReason] = (bulkSkipReasons[skipReason] ?? 0) + 1
      } else {
        actionableBatch.push(item)
      }
    }

    bulkSkippedCount = Object.values(bulkSkipReasons).reduce((a, b) => a + b, 0)

    if (bulkSkippedCount > 0) {
      const reasonParts = Object.entries(bulkSkipReasons)
        .map(([reason, count]) => `${count} ${formatTransferSkipReason(reason as TransferSkipReason)}`)
        .join(", ")
      try {
        await prisma.backgroundTaskEvent.create({
          data: {
            taskId: candidate.id,
            userId: actorUserId,
            eventType: "batch_skipped",
            message: `Skipped ${bulkSkippedCount} files (${reasonParts})`,
            metadata: {
              count: bulkSkippedCount,
              reasons: bulkSkipReasons,
            },
          },
        })
      } catch {
        // Non-critical
      }
    }
  }

  // If fast-forward exhausted all source files, persist the final skip
  // progress and return. The next worker poll will see an empty sourceBatch
  // and run the original completion handler (sync cleanup, audit, etc.).
  if (sourceBatch.length === 0 || (sourceBatch.length < batchSize && actionableBatch.length === 0)) {
    if (bulkSkippedCount > 0 && actionableBatch.length === 0) {
      progress.processed += bulkSkippedCount
      progress.skipped += bulkSkippedCount
      progress.cursorKey = mappedBatch[mappedBatch.length - 1]?.sourceFile.key ?? progress.cursorKey
      progress.remaining = Math.max(0, sourceTotal - progress.processed)
    }

    const ffFinalCheckpoint = await persistClaimedTaskCheckpoint({
      taskId: candidate.id,
      userId: actorUserId,
      claimedRunCount: candidate.runCount + 1,
      normalUpdate: {
        status: "in_progress",
        attempts: 0,
        nextRunAt: new Date(),
        progress: progress as unknown as Prisma.InputJsonObject,
        lastError: null,
        completedAt: null,
      },
    })

    return buildProcessedResponse(
      snapshotFromCheckpoint(candidate, actorUserId, ffFinalCheckpoint),
      {
        done: ffFinalCheckpoint.appliedMode === "canceled",
        type: "object_transfer",
        processedInBatch: progress.processed,
        copiedInBatch: 0,
        movedInBatch: 0,
        skippedInBatch: progress.skipped,
        failedInBatch: 0,
        timeBudgetReached: false,
      }
    )
  }

  let copiedInBatch = 0
  let movedInBatch = 0
  let deletedInBatch = 0
  let skippedInBatch = bulkSkippedCount
  let failedInBatch = 0
  let processedInBatch = bulkSkippedCount
  let lastProcessedCursorKey = progress.cursorKey
  let timeBudgetReached = false
  let batchLastError: string | null = null
  const staleDestinationKeys: string[] = []
  const batchStartedAt = Date.now()
  const transferItemConcurrency = getTaskTransferItemConcurrency()
  // Only 1 relay upload at a time per task. Server copies run at full
  // concurrency — the semaphore only gates the relay path.
  const relaySemaphore = new AsyncSemaphore(1)
  const claimedTaskId = candidate.id
  const claimedRunCount = candidate.runCount + 1
  const transferProgressMinFileSizeBytes =
    BigInt(getTaskTransferProgressMinFileSizeMb()) * ONE_MEBIBYTE_BIGINT
  const transferProgressSampleIntervalMs = getTaskTransferProgressSampleIntervalMs()
  const transferProgressSampleDeltaBytes =
    BigInt(getTaskTransferProgressSampleDeltaMb()) * ONE_MEBIBYTE_BIGINT
  const transferProgressMaxEventsPerFile = getTaskTransferProgressMaxEventsPerFile()

  interface LiveTransferTelemetryState {
    sourceKey: string
    destinationKey: string
    strategy: TransferStrategy | null
    stage: TransferProgressStage | null
    fallbackReason: string | null
    totalBytes: bigint | null
    transferredBytes: bigint
    throughputBytesPerSec: number | null
    etaSeconds: number | null
    lastProgressAtMs: number | null
    lastSpeedSampleAtMs: number | null
    lastSpeedSampleBytes: bigint
    lastSampleAtMs: number | null
    lastSampleBytes: bigint
    lastSampleStage: TransferProgressStage | null
    emittedMilestones: Set<number>
    sampledEvents: number
  }

  const transferTelemetryByFile = new Map<string, LiveTransferTelemetryState>()
  let activeTransferTelemetryKey: string | null = null
  let telemetryWriteQueue = Promise.resolve()
  let lastTelemetryProgressPersistAt = 0

  function getTelemetryStateKey(sourceKey: string, destinationKey: string): string {
    return `${sourceKey}::${destinationKey}`
  }

  function getOrCreateTelemetryState(
    sourceKey: string,
    destinationKey: string
  ): LiveTransferTelemetryState {
    const key = getTelemetryStateKey(sourceKey, destinationKey)
    const existing = transferTelemetryByFile.get(key)
    if (existing) return existing

    const created: LiveTransferTelemetryState = {
      sourceKey,
      destinationKey,
      strategy: null,
      stage: null,
      fallbackReason: null,
      totalBytes: null,
      transferredBytes: BigInt(0),
      throughputBytesPerSec: null,
      etaSeconds: null,
      lastProgressAtMs: null,
      lastSpeedSampleAtMs: null,
      lastSpeedSampleBytes: BigInt(0),
      lastSampleAtMs: null,
      lastSampleBytes: BigInt(0),
      lastSampleStage: null,
      emittedMilestones: new Set<number>(),
      sampledEvents: 0,
    }
    transferTelemetryByFile.set(key, created)
    return created
  }

  function getActiveTelemetryState(): LiveTransferTelemetryState | null {
    if (!activeTransferTelemetryKey) return null
    return transferTelemetryByFile.get(activeTransferTelemetryKey) ?? null
  }

  function buildLiveTransferProgressSnapshot(): ObjectTransferTaskProgress {
    const activeTelemetryState = getActiveTelemetryState()
    const activeTransferredBytes = activeTelemetryState?.transferredBytes ?? BigInt(0)
    const bytesProcessedWithCurrent = bytesProcessedCompleted + activeTransferredBytes
    const boundedBytesProcessed =
      bytesEstimatedTotal !== null && bytesProcessedWithCurrent > bytesEstimatedTotal
        ? bytesEstimatedTotal
        : bytesProcessedWithCurrent

    return {
      phase: "transfer",
      total: sourceTotal,
      processed: progress.processed + processedInBatch,
      copied: progress.copied + copiedInBatch,
      moved: progress.moved + movedInBatch,
      deleted: progress.deleted + deletedInBatch,
      skipped: progress.skipped + skippedInBatch,
      failed: progress.failed + failedInBatch,
      remaining: Math.max(0, sourceTotal - (progress.processed + processedInBatch)),
      cursorKey: lastProcessedCursorKey,
      currentFileKey: activeTelemetryState?.sourceKey ?? null,
      currentFileSizeBytes: activeTelemetryState?.totalBytes?.toString() ?? null,
      currentFileTransferredBytes: activeTelemetryState
        ? activeTelemetryState.transferredBytes.toString()
        : null,
      currentFileStage: activeTelemetryState?.stage ?? null,
      transferStrategy: activeTelemetryState?.strategy ?? null,
      fallbackReason: activeTelemetryState?.fallbackReason ?? null,
      bytesProcessedTotal: boundedBytesProcessed.toString(),
      bytesEstimatedTotal: bytesEstimatedTotal?.toString() ?? null,
      throughputBytesPerSec: activeTelemetryState?.throughputBytesPerSec ?? null,
      etaSeconds: activeTelemetryState?.etaSeconds ?? null,
      lastProgressAt: activeTelemetryState?.lastProgressAtMs
        ? new Date(activeTelemetryState.lastProgressAtMs).toISOString()
        : null,
    }
  }

  function queueTelemetryWrite(operation: () => Promise<void>) {
    telemetryWriteQueue = telemetryWriteQueue
      .then(operation)
      .catch(() => {
        // Telemetry writes are best effort and should not fail task processing.
      })
  }

  function persistLiveProgressSnapshot(force = false) {
    const nowMs = Date.now()
    if (!force && nowMs - lastTelemetryProgressPersistAt < transferProgressSampleIntervalMs) {
      return
    }
    lastTelemetryProgressPersistAt = nowMs
    const snapshot = buildLiveTransferProgressSnapshot()
    queueTelemetryWrite(async () => {
      await prisma.backgroundTask.updateMany({
        where: {
          id: claimedTaskId,
          userId: actorUserId,
          runCount: claimedRunCount,
          status: "in_progress",
        },
        data: {
          progress: snapshot as unknown as Prisma.InputJsonObject,
          nextRunAt: new Date(Date.now() + LOCK_SECONDS * 1000),
        },
      })
    })
  }

  function emitSampledProgressEvent(
    state: LiveTransferTelemetryState,
    sampleReason: TransferProgressSampleReason
  ) {
    if (state.sampledEvents >= transferProgressMaxEventsPerFile) return
    if (state.totalBytes === null || state.totalBytes < transferProgressMinFileSizeBytes) return

    const percent =
      state.totalBytes && state.totalBytes > BigInt(0)
        ? Math.min(100, Math.floor((bigintToNumberLossy(state.transferredBytes) * 100) / Math.max(1, bigintToNumberLossy(state.totalBytes))))
        : null
    const throughputLabel =
      state.throughputBytesPerSec !== null
        ? `${Math.max(0, Math.round(state.throughputBytesPerSec))} B/s`
        : "n/a"
    const etaLabel =
      state.etaSeconds !== null
        ? `${Math.max(0, Math.floor(state.etaSeconds))}s`
        : "n/a"
    const message = [
      `PROGRESS ${activeTransferPayload.sourceBucket}/${state.sourceKey} -> ${activeTransferPayload.destinationBucket}/${state.destinationKey}`,
      percent !== null ? `${percent}%` : "size unknown",
      `stage=${state.stage ?? "copying"}`,
      `speed=${throughputLabel}`,
      `eta=${etaLabel}`,
    ].join(" ")

    state.sampledEvents += 1
    queueTelemetryWrite(async () => {
      await prisma.backgroundTaskEvent.create({
        data: {
          taskId: claimedTaskId,
          userId: actorUserId,
          eventType: "file_progress",
          message,
          metadata: {
            sourceKey: state.sourceKey,
            destinationKey: state.destinationKey,
            stage: state.stage,
            strategy: state.strategy,
            transferredBytes: state.transferredBytes.toString(),
            totalBytes: state.totalBytes?.toString() ?? null,
            throughputBytesPerSec: state.throughputBytesPerSec,
            etaSeconds: state.etaSeconds,
            sampleReason,
          },
        },
      })
    })
  }

  function markReachedMilestones(state: LiveTransferTelemetryState) {
    if (!state.totalBytes || state.totalBytes <= BigInt(0)) return
    for (const milestone of TRANSFER_PROGRESS_MILESTONES) {
      const threshold = (state.totalBytes * BigInt(milestone)) / BigInt(100)
      if (state.transferredBytes >= threshold) {
        state.emittedMilestones.add(milestone)
      }
    }
  }

  function maybeEmitProgressSample(
    state: LiveTransferTelemetryState,
    nowMs: number,
    stageChanged: boolean
  ) {
    if (state.sampledEvents >= transferProgressMaxEventsPerFile) return
    if (state.totalBytes === null || state.totalBytes < transferProgressMinFileSizeBytes) return

    const reachedNewMilestone =
      state.totalBytes && state.totalBytes > BigInt(0)
        ? TRANSFER_PROGRESS_MILESTONES.some((milestone) => {
          if (state.emittedMilestones.has(milestone)) return false
          const threshold = (state.totalBytes! * BigInt(milestone)) / BigInt(100)
          return state.transferredBytes >= threshold
        })
        : false

    const intervalTriggered =
      state.lastSampleAtMs === null || nowMs - state.lastSampleAtMs >= transferProgressSampleIntervalMs
    const deltaTriggered =
      state.transferredBytes - state.lastSampleBytes >= transferProgressSampleDeltaBytes

    let reason: TransferProgressSampleReason | null = null
    if (stageChanged) {
      reason = "stage_change"
    } else if (reachedNewMilestone) {
      reason = "milestone"
    } else if (deltaTriggered) {
      reason = "delta"
    } else if (intervalTriggered) {
      reason = "interval"
    }

    if (!reason) return

    emitSampledProgressEvent(state, reason)
    state.lastSampleAtMs = nowMs
    state.lastSampleBytes = state.transferredBytes
    state.lastSampleStage = state.stage
    markReachedMilestones(state)
  }

  function updateTelemetryProgressSpeed(state: LiveTransferTelemetryState, nowMs: number) {
    if (state.lastSpeedSampleAtMs === null) {
      state.lastSpeedSampleAtMs = nowMs
      state.lastSpeedSampleBytes = state.transferredBytes
      return
    }

    const deltaMs = nowMs - state.lastSpeedSampleAtMs
    const deltaBytes = state.transferredBytes - state.lastSpeedSampleBytes
    if (deltaMs <= 0 || deltaBytes < BigInt(0)) {
      return
    }

    const instantBytesPerSecond = (bigintToNumberLossy(deltaBytes) * 1000) / deltaMs
    if (Number.isFinite(instantBytesPerSecond) && instantBytesPerSecond >= 0) {
      state.throughputBytesPerSec =
        state.throughputBytesPerSec === null
          ? instantBytesPerSecond
          : state.throughputBytesPerSec * 0.7 + instantBytesPerSecond * 0.3
    }

    state.lastSpeedSampleAtMs = nowMs
    state.lastSpeedSampleBytes = state.transferredBytes

    if (
      state.totalBytes !== null &&
      state.totalBytes > BigInt(0) &&
      state.throughputBytesPerSec &&
      state.throughputBytesPerSec > 0 &&
      state.transferredBytes <= state.totalBytes
    ) {
      const remainingBytes = state.totalBytes - state.transferredBytes
      state.etaSeconds = Math.ceil(
        bigintToNumberLossy(remainingBytes) / state.throughputBytesPerSec
      )
    } else {
      state.etaSeconds = null
    }
  }

  // ---------------------------------------------------------------------------
  // Adaptive fallback: track consecutive server-copy failures at the task level.
  // After ADAPTIVE_FALLBACK_THRESHOLD consecutive files trigger a fallback to
  // relay upload, skip server-copy attempts entirely for the remaining files
  // to avoid ~2 wasted S3 API calls per file.
  // ---------------------------------------------------------------------------
  const ADAPTIVE_FALLBACK_THRESHOLD = 3
  let consecutiveServerCopyFallbacks = 0
  let adaptiveForcedStrategy: TransferStrategy | null = null
  let adaptiveFallbackLogged = false

  const transferTelemetryHooks: TransferTelemetryHooks = {
    start: ({ sourceKey, destinationKey, strategy, totalBytes }) => {
      const state = getOrCreateTelemetryState(sourceKey, destinationKey)
      state.strategy = strategy
      state.totalBytes = totalBytes ?? state.totalBytes
      state.stage = "queued"
      state.fallbackReason = null
      state.transferredBytes = BigInt(0)
      state.throughputBytesPerSec = null
      state.etaSeconds = null
      const nowMs = Date.now()
      state.lastProgressAtMs = nowMs
      state.lastSpeedSampleAtMs = null
      state.lastSpeedSampleBytes = BigInt(0)
      activeTransferTelemetryKey = getTelemetryStateKey(sourceKey, destinationKey)
      persistLiveProgressSnapshot(true)
      maybeEmitProgressSample(state, nowMs, true)
    },
    progress: ({ sourceKey, destinationKey, strategy, transferredBytes, totalBytes, stage }) => {
      const state = getOrCreateTelemetryState(sourceKey, destinationKey)
      const previousStage = state.stage
      state.strategy = strategy
      state.totalBytes = totalBytes ?? state.totalBytes
      state.transferredBytes = transferredBytes < BigInt(0) ? BigInt(0) : transferredBytes
      if (state.totalBytes !== null && state.transferredBytes > state.totalBytes) {
        state.transferredBytes = state.totalBytes
      }
      state.stage = stage ?? state.stage ?? "copying"
      const nowMs = Date.now()
      state.lastProgressAtMs = nowMs
      updateTelemetryProgressSpeed(state, nowMs)
      activeTransferTelemetryKey = getTelemetryStateKey(sourceKey, destinationKey)
      maybeEmitProgressSample(state, nowMs, previousStage !== state.stage)
      persistLiveProgressSnapshot(false)
    },
    stage: ({ sourceKey, destinationKey, strategy, stage }) => {
      const state = getOrCreateTelemetryState(sourceKey, destinationKey)
      const previousStage = state.stage
      state.strategy = strategy ?? state.strategy
      state.stage = stage
      const nowMs = Date.now()
      state.lastProgressAtMs = nowMs
      activeTransferTelemetryKey = getTelemetryStateKey(sourceKey, destinationKey)
      maybeEmitProgressSample(state, nowMs, previousStage !== stage)
      persistLiveProgressSnapshot(true)
    },
    fallback: ({ sourceKey, destinationKey, reason, nextStrategy }) => {
      const state = getOrCreateTelemetryState(sourceKey, destinationKey)
      state.fallbackReason = reason
      state.strategy = nextStrategy
      state.lastProgressAtMs = Date.now()
      activeTransferTelemetryKey = getTelemetryStateKey(sourceKey, destinationKey)
      persistLiveProgressSnapshot(true)

      // Track consecutive fallbacks to relay for adaptive strategy override
      if (nextStrategy === "multipart_relay_upload") {
        consecutiveServerCopyFallbacks++
        if (
          consecutiveServerCopyFallbacks >= ADAPTIVE_FALLBACK_THRESHOLD &&
          !adaptiveForcedStrategy
        ) {
          adaptiveForcedStrategy = "multipart_relay_upload"
          if (!adaptiveFallbackLogged) {
            adaptiveFallbackLogged = true
            try {
              prisma.backgroundTaskEvent.create({
                data: {
                  taskId: claimedTaskId,
                  userId: actorUserId,
                  eventType: "adaptive_fallback",
                  message:
                    `Server copy failed for ${consecutiveServerCopyFallbacks} consecutive files; ` +
                    `using relay for remaining files. Last reason: ${reason}`,
                  metadata: {
                    consecutiveFailures: consecutiveServerCopyFallbacks,
                    lastFallbackReason: reason,
                  },
                },
              }).catch(() => {})
            } catch {
              // Non-critical
            }
          }
        }
      }
    },
    finish: ({ sourceKey, destinationKey, strategy, status }) => {
      const state = getOrCreateTelemetryState(sourceKey, destinationKey)
      const previousStage = state.stage
      state.strategy = strategy ?? state.strategy
      state.stage = status === "completed" ? "completed" : "failed"
      if (status === "completed" && state.totalBytes !== null) {
        state.transferredBytes = state.totalBytes
      }
      const nowMs = Date.now()
      state.lastProgressAtMs = nowMs
      maybeEmitProgressSample(state, nowMs, previousStage !== state.stage)
      persistLiveProgressSnapshot(true)

      // Reset consecutive fallback counter when a file completes without fallback
      if (status === "completed" && !state.fallbackReason) {
        consecutiveServerCopyFallbacks = 0
      }
    },
  }

  for (let index = 0; index < actionableBatch.length; ) {
    // Relay uploads are serialized via relaySemaphore (1 at a time), so
    // we can keep full item concurrency — server copies still run in
    // parallel while relay calls queue up behind the semaphore.
    const effectiveConcurrency = transferItemConcurrency
    if (
      processedInBatch > 0 &&
      Date.now() - batchStartedAt >= getTaskWorkerUserBudgetMs()
    ) {
      timeBudgetReached = true
      break
    }

    // Extend the task lock before each slice to prevent expiration during
    // long-running S3 operations (multipart relay/copy of large files).
    await refreshTaskLock({
      taskId: candidate.id,
      userId: actorUserId,
      claimedRunCount: candidate.runCount + 1,
    })

    const slice = actionableBatch.slice(index, index + effectiveConcurrency)
    const prepared = await Promise.all(
      slice.map(async ({ sourceFile, destinationKey }): Promise<PreparedTransferItem> => {
        let destinationExisting = requiresDestinationComparison
          ? destinationByKey.get(destinationKey)
          : undefined
        let destinationExistsRemotely = false

        if (requiresDestinationComparison && !destinationExisting) {
          try {
            const remoteSnapshot = await readRemoteObjectSnapshot({
              client: destinationClient,
              bucket: activeTransferPayload.destinationBucket,
              key: destinationKey,
            })
            if (remoteSnapshot) {
              destinationExistsRemotely = true
              if (remoteSnapshot.size !== null && remoteSnapshot.lastModified) {
                destinationExisting = {
                  size: remoteSnapshot.size,
                  lastModified: remoteSnapshot.lastModified,
                }
                destinationByKey.set(destinationKey, destinationExisting)
              }
            }
          } catch {
            // If destination verification fails, continue with normal transfer flow.
          }
        }

        const createsNewDestination = !destinationExisting && !destinationExistsRemotely
        const shouldSkipForExistingDestination =
          activeTransferPayload.operation === "copy" &&
          (destinationExisting || destinationExistsRemotely)
        let shouldSkipForUpToDateSync =
          activeTransferPayload.operation === "sync" &&
          destinationExisting &&
          isDestinationUpToDateForSync(
            {
              size: sourceFile.size,
              lastModified: sourceFile.lastModified,
            },
            destinationExisting
          )

        // When sync would skip based on cached metadata, verify the
        // destination object actually exists in S3. The cache can be stale
        // if files were deleted outside the app (lifecycle rules, external
        // tools, etc.), causing the sync to incorrectly skip missing files.
        if (shouldSkipForUpToDateSync && !destinationExistsRemotely) {
          try {
            const verifySnapshot = await readRemoteObjectSnapshot({
              client: destinationClient,
              bucket: activeTransferPayload.destinationBucket,
              key: destinationKey,
            })
            if (!verifySnapshot) {
              shouldSkipForUpToDateSync = false
              destinationByKey.delete(destinationKey)
              staleDestinationKeys.push(destinationKey)
            }
          } catch {
            // Verification failed — be safe, proceed with copy.
            shouldSkipForUpToDateSync = false
          }
        }

        return {
          sourceFile,
          destinationKey,
          createsNewDestination: !destinationExisting && !destinationExistsRemotely,
          skip: Boolean(shouldSkipForExistingDestination || shouldSkipForUpToDateSync),
          skipReason:
            shouldSkipForExistingDestination
              ? "already_exists"
              : shouldSkipForUpToDateSync
                ? "up_to_date"
                : null,
        }
      })
    )

    const actionable: PreparedTransferItem[] = []
    const skippedForResults: Array<{
      sourceFile: TransferSourceRow
      destinationKey: string
      reason: TransferSkipReason
    }> = []
    for (const item of prepared) {
      if (item.skip) {
        skippedInBatch++
        processedInBatch++
        skippedForResults.push({
          sourceFile: item.sourceFile,
          destinationKey: item.destinationKey,
          reason: item.skipReason ?? "up_to_date",
        })
        continue
      }

      if (item.createsNewDestination && remainingCacheSlots !== null) {
        if (remainingCacheSlots <= 0) {
          skippedInBatch++
          processedInBatch++
          skippedForResults.push({
            sourceFile: item.sourceFile,
            destinationKey: item.destinationKey,
            reason: "cache_limit_reached",
          })
          continue
        }
        remainingCacheSlots -= 1
      }

      actionable.push(item)
    }

    const retryMaxAttempts = getTaskTransferItemRetryMaxAttempts()
    const retryBaseDelayMs = getTaskTransferItemRetryBaseDelayMs()

    let results = await Promise.all(
      actionable.map(async (item): Promise<TransferItemResult> => {
        let lastError: unknown = null

        for (let attempt = 0; attempt <= retryMaxAttempts; attempt++) {
          try {
            if (attempt > 0) {
              const delay = computeRetryDelayMs(attempt - 1, retryBaseDelayMs)
              await sleep(delay)
            }

            await copyObjectAcrossLocations({
              sourceClient,
              destinationClient,
              sameCredential,
              sourceEndpoint: sourceClientInfo.credential.endpoint,
              destinationEndpoint: destinationClientInfo.credential.endpoint,
              sourceRegion: sourceClientInfo.credential.region,
              destinationRegion: destinationClientInfo.credential.region,
              sourceProvider: sourceClientInfo.credential.provider,
              destinationProvider: destinationClientInfo.credential.provider,
              sourceBucket: activeTransferPayload.sourceBucket,
              sourceKey: item.sourceFile.key,
              destinationBucket: activeTransferPayload.destinationBucket,
              destinationKey: item.destinationKey,
              expectedContentLength: item.sourceFile.size,
              telemetry: transferTelemetryHooks,
              forceStrategy: adaptiveForcedStrategy ?? undefined,
              relaySemaphore,
            })

            return {
              status: "copied",
              sourceId: item.sourceFile.id,
              sourceKey: item.sourceFile.key,
              destinationKey: item.destinationKey,
              extension: item.sourceFile.extension,
              size: item.sourceFile.size,
              lastModified: item.sourceFile.lastModified,
              createsNewDestination: item.createsNewDestination,
              sourceDeleteRequired:
                activeTransferPayload.operation === "move" ||
                activeTransferPayload.operation === "migrate",
              errorMessage: null,
            }
          } catch (itemError) {
            lastError = itemError

            // Don't retry non-transient errors or missing source
            if (isS3MissingObjectError(itemError) || !isTransientS3Error(itemError)) {
              break
            }

            // Don't retry if we've exhausted attempts
            if (attempt >= retryMaxAttempts) {
              break
            }
          }
        }

        const errorCode = getS3ErrorCode(lastError)
        const errorMessage = formatTaskProcessingError(lastError)
        return {
          status: errorCode === "NoSuchKey" ? "missing_source" : "failed",
          sourceId: item.sourceFile.id,
          sourceKey: item.sourceFile.key,
          destinationKey: item.destinationKey,
          extension: item.sourceFile.extension,
          size: item.sourceFile.size,
          lastModified: item.sourceFile.lastModified,
          createsNewDestination: item.createsNewDestination,
          sourceDeleteRequired: false,
          errorMessage,
        }
      })
    )

    const missingSourceIds = results
      .filter((result) => result.status === "missing_source")
      .map((result) => result.sourceId)
    if (missingSourceIds.length > 0) {
      await prisma.fileMetadata.deleteMany({
        where: {
          id: {
            in: missingSourceIds,
          },
          userId: actorUserId,
        },
      })
    }

    const copiedRows = results.filter((result) => result.status === "copied")
    if (copiedRows.length > 0) {
      await upsertFileMetadataBatch(
        copiedRows.map((result) => ({
          userId: actorUserId,
          credentialId: activeTransferPayload.destinationCredentialId,
          bucket: activeTransferPayload.destinationBucket,
          key: result.destinationKey,
          extension: result.extension,
          size: result.size,
          lastModified: result.lastModified,
        }))
      )

      for (const result of copiedRows) {
        destinationByKey.set(result.destinationKey, {
          size: result.size,
          lastModified: result.lastModified,
        })
      }
    }

    if (
      (activeTransferPayload.operation === "move" || activeTransferPayload.operation === "migrate") &&
      copiedRows.length > 0
    ) {
      await Promise.all(
        copiedRows.map((result) =>
          transferTelemetryHooks.stage?.({
            sourceKey: result.sourceKey,
            destinationKey: result.destinationKey,
            strategy: null,
            stage: "deleting_source",
          })
        )
      )

      const deletedSourceKeys = await deleteKeysFromBucket(
        sourceClient,
        activeTransferPayload.sourceBucket,
        copiedRows.map((result) => result.sourceKey)
      )
      const movedSourceIds: string[] = []

      results = results.map((result) => {
        if (result.status !== "copied" || !result.sourceDeleteRequired) {
          return result
        }

        if (deletedSourceKeys.has(result.sourceKey)) {
          movedSourceIds.push(result.sourceId)
          return {
            ...result,
            status: "moved",
          }
        }

        return {
          ...result,
          status: "failed",
          errorMessage:
            result.errorMessage ??
            `Failed to delete source object '${result.sourceKey}' after transfer`,
        }
      })

      if (movedSourceIds.length > 0) {
        await prisma.fileMetadata.deleteMany({
          where: {
            id: {
              in: movedSourceIds,
            },
            userId: actorUserId,
          },
        })
      }
    }

    for (const result of results) {
      const destinationPersisted =
        result.status === "copied" ||
        result.status === "moved" ||
        (result.status === "failed" && result.sourceDeleteRequired)
      if (
        result.createsNewDestination &&
        remainingCacheSlots !== null &&
        !destinationPersisted
      ) {
        remainingCacheSlots += 1
      }

      // missing_source items are handled gracefully (stale source cache
      // entries cleaned up), so don't surface their error as a task-level error.
      if (!batchLastError && result.errorMessage && result.status !== "missing_source") {
        batchLastError = result.errorMessage
      }

      processedInBatch++
      if (result.status === "copied") {
        copiedInBatch++
        bytesProcessedCompleted += result.size
      } else if (result.status === "moved") {
        movedInBatch++
        deletedInBatch++
        bytesProcessedCompleted += result.size
      } else if (result.status === "skipped" || result.status === "missing_source") {
        skippedInBatch++
      } else {
        if (result.status === "failed" && result.sourceDeleteRequired) {
          bytesProcessedCompleted += result.size
        }
        failedInBatch++
      }

      const telemetryStateKey = getTelemetryStateKey(result.sourceKey, result.destinationKey)
      transferTelemetryByFile.delete(telemetryStateKey)
      if (activeTransferTelemetryKey === telemetryStateKey) {
        activeTransferTelemetryKey = transferTelemetryByFile.keys().next().value ?? null
      }
    }

    persistLiveProgressSnapshot(true)

    // Record per-file events for this slice
    const fileEvents: Prisma.BackgroundTaskEventCreateManyInput[] = []
    for (const skippedItem of skippedForResults) {
      const reasonLabel = formatTransferSkipReason(skippedItem.reason)
      fileEvents.push({
        taskId: candidate.id,
        userId: actorUserId,
        eventType: "file_skipped",
        message: `SKIP ${activeTransferPayload.sourceBucket}/${skippedItem.sourceFile.key} -> ${activeTransferPayload.destinationBucket}/${skippedItem.destinationKey} (${reasonLabel})`,
        metadata: {
          sourceKey: skippedItem.sourceFile.key,
          destinationKey: skippedItem.destinationKey,
          size: skippedItem.sourceFile.size.toString(),
          reason: skippedItem.reason,
        },
      })
    }
    for (const result of results) {
      fileEvents.push({
        taskId: candidate.id,
        userId: actorUserId,
        eventType: `file_${result.status}`,
        message: `${result.status.toUpperCase()} ${activeTransferPayload.sourceBucket}/${result.sourceKey} -> ${activeTransferPayload.destinationBucket}/${result.destinationKey}`,
        metadata: {
          sourceKey: result.sourceKey,
          destinationKey: result.destinationKey,
          size: result.size.toString(),
          error: result.errorMessage ?? undefined,
        },
      })
    }
    if (fileEvents.length > 0) {
      try {
        await prisma.backgroundTaskEvent.createMany({ data: fileEvents })
      } catch {
        // Non-critical: don't fail the task if event recording fails
      }
    }

    lastProcessedCursorKey = slice[slice.length - 1]?.sourceFile.key ?? lastProcessedCursorKey
    index += effectiveConcurrency
  }

  // When the actionable loop completed fully (no time budget break),
  // advance cursor to the end of the original batch so bulk-skipped
  // files at the tail are not re-fetched in the next batch call.
  if (!timeBudgetReached && bulkSkippedCount > 0 && mappedBatch.length > 0) {
    const lastBatchKey = mappedBatch[mappedBatch.length - 1]!.sourceFile.key
    if (!lastProcessedCursorKey || lastBatchKey > lastProcessedCursorKey) {
      lastProcessedCursorKey = lastBatchKey
    }
  }

  // Clean up stale destination metadata entries discovered during sync
  // verification. These are cache entries for files no longer in S3.
  if (staleDestinationKeys.length > 0) {
    await prisma.fileMetadata.deleteMany({
      where: {
        userId: actorUserId,
        credentialId: activeTransferPayload.destinationCredentialId,
        bucket: activeTransferPayload.destinationBucket,
        key: { in: staleDestinationKeys },
      },
    })
  }

  await telemetryWriteQueue

  const total = sourceTotal
  const nextProcessed = progress.processed + processedInBatch
  const nextProgress: ObjectTransferTaskProgress = {
    phase: "transfer",
    total,
    processed: nextProcessed,
    copied: progress.copied + copiedInBatch,
    moved: progress.moved + movedInBatch,
    deleted: progress.deleted + deletedInBatch,
    skipped: progress.skipped + skippedInBatch,
    failed: progress.failed + failedInBatch,
    remaining: Math.max(0, total - nextProcessed),
    cursorKey: lastProcessedCursorKey,
    currentFileKey: null,
    currentFileSizeBytes: null,
    currentFileTransferredBytes: null,
    currentFileStage: null,
    transferStrategy: null,
    fallbackReason: null,
    bytesProcessedTotal: bytesProcessedCompleted.toString(),
    bytesEstimatedTotal: bytesEstimatedTotal?.toString() ?? null,
    throughputBytesPerSec: null,
    etaSeconds: null,
    lastProgressAt: null,
  }

  const transferCheckpoint = await persistClaimedTaskCheckpoint({
    taskId: candidate.id,
    userId: actorUserId,
    claimedRunCount: candidate.runCount + 1,
    normalUpdate: {
      status: "in_progress",
      attempts: 0,
      nextRunAt: new Date(),
      progress: nextProgress as unknown as Prisma.InputJsonObject,
      lastError:
        batchLastError ??
        (nextProgress.failed > 0
          ? candidate.lastError ?? "One or more objects failed during transfer"
          : null),
      completedAt: null,
    },
  })

  return buildProcessedResponse(
    snapshotFromCheckpoint(candidate, actorUserId, transferCheckpoint, {
      lastError:
        transferCheckpoint.appliedMode === "canceled"
          ? null
          : batchLastError ??
            (nextProgress.failed > 0
              ? candidate.lastError ?? "One or more objects failed during transfer"
              : null),
    }),
    {
      done: transferCheckpoint.appliedMode === "canceled",
      type: "object_transfer",
      processedInBatch,
      copiedInBatch,
      movedInBatch,
      skippedInBatch,
      failedInBatch,
      timeBudgetReached,
    }
  )
}
