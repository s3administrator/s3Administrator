import {
  saveUploadState,
  removeUploadState,
  type PersistedUploadState,
} from "./upload-persistence"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MB = 1024 * 1024
const GB = 1024 * MB

const MULTIPART_THRESHOLD = 50 * MB
const MAX_CONCURRENT_PARTS = 4
const MAX_PART_RETRIES = 5
const BATCH_URL_SIZE = 8
const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 30_000
const SPEED_WINDOW_MS = 3_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UploadState =
  | "idle"
  | "uploading"
  | "paused"
  | "completing"
  | "done"
  | "error"

export interface UploadEngineCallbacks {
  onProgress: (bytesUploaded: number, totalBytes: number, speed: number) => void
  onStateChange: (state: UploadState) => void
  onComplete: () => void
  onError: (error: Error) => void
}

export interface UploadEngineConfig {
  bucket: string
  key: string
  credentialId?: string
  file: File
  contentType: string
  callbacks: UploadEngineCallbacks
}

interface SpeedSample {
  timestamp: number
  bytes: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeChunkSize(fileSize: number): number {
  // Smaller chunks = less data lost on pause (S3 minimum is 5 MB, max 10,000 parts)
  if (fileSize < 500 * MB) return 10 * MB
  if (fileSize < 2 * GB) return 25 * MB
  if (fileSize < 10 * GB) return 50 * MB
  return 100 * MB
}

export function shouldUseMultipart(fileSize: number): boolean {
  return fileSize >= MULTIPART_THRESHOLD
}

function isCorsLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return (
    normalized.includes("cors") ||
    normalized.includes("preflight") ||
    normalized.includes("access-control-allow-origin")
  )
}

// ---------------------------------------------------------------------------
// UploadEngine
//
// The engine uses a "pause gate" pattern: when paused, workers await a
// promise that only resolves when resume() is called.  This means start()
// stays alive across pause/resume cycles — no separate resume code path.
// ---------------------------------------------------------------------------

export class UploadEngine {
  private config: UploadEngineConfig
  private state: UploadState = "idle"
  private uploadId: string | null = null
  private completedParts: Map<number, string> = new Map()
  private totalParts = 0
  private chunkSize = 0
  private abortRequested = false

  // Pause gate: when paused, this promise is pending. resume() resolves it.
  private paused = false
  private userPaused = false
  private pauseGateResolve: (() => void) | null = null
  private pauseGate: Promise<void> | null = null

  // Progress tracking
  private partSizes: Map<number, number> = new Map()
  private inFlightProgress: Map<number, number> = new Map()
  private speedSamples: SpeedSample[] = []

  // Active XHRs
  private activeXHRs: Set<XMLHttpRequest> = new Set()

  // URL cache
  private urlCache: Map<number, string> = new Map()
  private urlFetchInFlight: Promise<void> | null = null

  // Network listeners
  private boundHandleOffline: (() => void) | null = null
  private boundHandleOnline: (() => void) | null = null
  private onlineResumeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: UploadEngineConfig) {
    this.config = config
    this.chunkSize = computeChunkSize(config.file.size)
    this.totalParts = Math.ceil(config.file.size / this.chunkSize)
    this.precomputePartSizes()
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Start the upload. Resolves when fully done, errored, or aborted. */
  async start(): Promise<void> {
    if (this.state !== "idle") return

    this.setupNetworkListeners()

    if (!shouldUseMultipart(this.config.file.size)) {
      await this.uploadSinglePut()
      return
    }

    this.setState("uploading")

    try {
      const startRes = await fetch("/api/s3/upload/multipart/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket: this.config.bucket,
          key: this.config.key,
          credentialId: this.config.credentialId,
          contentType: this.config.contentType,
        }),
      })

      if (!startRes.ok) throw new Error("Failed to start multipart upload")

      const { uploadId } = await startRes.json()
      if (!uploadId) throw new Error("Missing uploadId")
      this.uploadId = uploadId

      this.persistState()
      await this.uploadAllParts()

      if (!this.abortRequested) {
        await this.completeMultipartUpload()
      }
    } catch (error) {
      if (!this.abortRequested && isCorsLikeError(error)) {
        try {
          await this.cleanupMultipartForFallback()
          await this.uploadSinglePut()
          return
        } catch (fallbackError) {
          error = fallbackError
        }
      }

      if (!this.abortRequested) {
        this.setState("error")
        this.config.callbacks.onError(
          error instanceof Error ? error : new Error(String(error))
        )
      }
    }
  }

  /** Resume a previously persisted upload. Same lifecycle as start(). */
  async resumeFromPersistedState(saved: PersistedUploadState): Promise<void> {
    this.uploadId = saved.uploadId
    this.chunkSize = saved.chunkSize
    this.totalParts = saved.totalParts
    this.precomputePartSizes()

    this.setupNetworkListeners()
    this.setState("uploading")

    try {
      const res = await fetch("/api/s3/upload/multipart/list-parts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket: this.config.bucket,
          key: this.config.key,
          credentialId: this.config.credentialId,
          uploadId: this.uploadId,
        }),
      })

      if (!res.ok) {
        throw new Error("Failed to verify upload state — upload may have expired")
      }

      const data = await res.json()
      this.completedParts.clear()

      for (const part of data.parts as Array<{ partNumber: number; etag: string; size: number }>) {
        this.completedParts.set(part.partNumber, part.etag)
      }

      this.emitProgress()
      await this.uploadAllParts()

      if (!this.abortRequested) {
        await this.completeMultipartUpload()
      }
    } catch (error) {
      if (!this.abortRequested && isCorsLikeError(error)) {
        try {
          await this.cleanupMultipartForFallback()
          await this.uploadSinglePut()
          return
        } catch (fallbackError) {
          error = fallbackError
        }
      }

      if (!this.abortRequested) {
        this.setState("error")
        this.config.callbacks.onError(
          error instanceof Error ? error : new Error(String(error))
        )
      }
    }
  }

  pause(): void {
    if (this.state !== "uploading") return
    this.paused = true
    this.userPaused = true

    // Abort all in-flight XHRs so pause is immediate
    for (const xhr of this.activeXHRs) {
      xhr.abort()
    }
    this.activeXHRs.clear()
    this.inFlightProgress.clear()

    // Create the gate that workers will await
    this.pauseGate = new Promise<void>((resolve) => {
      this.pauseGateResolve = resolve
    })

    this.setState("paused")
    // Emit progress based on completed parts only (in-flight was lost).
    // This keeps the bar at the last "saved" position instead of jumping to 0.
    this.emitProgress()
  }

  resume(): void {
    if (this.state !== "paused") return
    this.paused = false
    this.userPaused = false
    this.speedSamples = []

    // Open the gate — all waiting workers continue
    if (this.pauseGateResolve) {
      this.pauseGateResolve()
      this.pauseGateResolve = null
      this.pauseGate = null
    }

    this.setState("uploading")
    // Emit progress so speed tracking restarts from the correct baseline
    this.emitProgress()
  }

  async abort(): Promise<void> {
    this.abortRequested = true

    for (const xhr of this.activeXHRs) {
      xhr.abort()
    }
    this.activeXHRs.clear()

    // If paused, release the gate so workers can exit
    if (this.pauseGateResolve) {
      this.pauseGateResolve()
      this.pauseGateResolve = null
      this.pauseGate = null
    }

    this.cleanupNetworkListeners()

    if (this.uploadId) {
      removeUploadState(this.uploadId)

      await fetch("/api/s3/upload/multipart/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket: this.config.bucket,
          key: this.config.key,
          credentialId: this.config.credentialId,
          uploadId: this.uploadId,
        }),
      }).catch(() => {})
    }
  }

  private async cleanupMultipartForFallback(): Promise<void> {
    if (!this.uploadId) {
      return
    }

    const uploadId = this.uploadId
    removeUploadState(uploadId)

    await fetch("/api/s3/upload/multipart/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket: this.config.bucket,
        key: this.config.key,
        credentialId: this.config.credentialId,
        uploadId,
      }),
    }).catch(() => {})

    this.uploadId = null
    this.completedParts.clear()
    this.inFlightProgress.clear()
    this.urlCache.clear()
    this.emitProgress()
  }

  getState(): UploadState {
    return this.state
  }

  getUploadId(): string | null {
    return this.uploadId
  }

  destroy(): void {
    this.cleanupNetworkListeners()
  }

  // ---------------------------------------------------------------------------
  // Pause gate helper
  // ---------------------------------------------------------------------------

  /** If paused, waits until resumed or aborted. Returns true if should abort. */
  private async waitIfPaused(): Promise<boolean> {
    while (this.paused && !this.abortRequested) {
      if (this.pauseGate) {
        await this.pauseGate
      }
    }
    return this.abortRequested
  }

  // ---------------------------------------------------------------------------
  // Part size precomputation
  // ---------------------------------------------------------------------------

  private precomputePartSizes(): void {
    this.partSizes.clear()
    for (let i = 1; i <= this.totalParts; i++) {
      const start = (i - 1) * this.chunkSize
      const end = Math.min(this.config.file.size, start + this.chunkSize)
      this.partSizes.set(i, end - start)
    }
  }

  // ---------------------------------------------------------------------------
  // Single PUT (files < threshold)
  // ---------------------------------------------------------------------------

  private async uploadSinglePut(): Promise<void> {
    this.setState("uploading")

    try {
      const presignRes = await fetch("/api/s3/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket: this.config.bucket,
          credentialId: this.config.credentialId,
          key: this.config.key,
        }),
      })

      if (!presignRes.ok) throw new Error("Failed to get upload URL")

      const { url } = await presignRes.json()
      const fileSize = this.config.file.size

      await this.uploadBlob(url, this.config.file, (loaded, total) => {
        const clamped = Math.min(loaded, total, fileSize)
        this.recordSpeedSample(clamped)
        this.config.callbacks.onProgress(clamped, fileSize, this.calculateSpeed())
      })

      this.setState("done")
      this.config.callbacks.onComplete()
    } catch (error) {
      if (isCorsLikeError(error)) {
        try {
          await this.ensureBucketCors()
          await this.uploadSinglePutRetry()
          return
        } catch {
          // fall through
        }
      }
      this.setState("error")
      this.config.callbacks.onError(
        error instanceof Error ? error : new Error(String(error))
      )
    }
  }

  private async uploadSinglePutRetry(): Promise<void> {
    const presignRes = await fetch("/api/s3/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket: this.config.bucket,
        credentialId: this.config.credentialId,
        key: this.config.key,
      }),
    })

    if (!presignRes.ok) throw new Error("Failed to get upload URL")

    const { url } = await presignRes.json()
    const fileSize = this.config.file.size

    await this.uploadBlob(url, this.config.file, (loaded, total) => {
      const clamped = Math.min(loaded, total, fileSize)
      this.recordSpeedSample(clamped)
      this.config.callbacks.onProgress(clamped, fileSize, this.calculateSpeed())
    })

    this.setState("done")
    this.config.callbacks.onComplete()
  }

  // ---------------------------------------------------------------------------
  // Multipart orchestration
  // ---------------------------------------------------------------------------

  private getPendingPartNumbers(): number[] {
    const pending: number[] = []
    for (let i = 1; i <= this.totalParts; i++) {
      if (!this.completedParts.has(i)) {
        pending.push(i)
      }
    }
    return pending
  }

  /**
   * Upload all pending parts. Handles pause/resume transparently:
   * workers await the pause gate when paused, then re-check pending parts
   * and continue when resumed.
   */
  private async uploadAllParts(): Promise<void> {
    while (true) {
      if (this.abortRequested) return

      const pendingParts = this.getPendingPartNumbers()
      if (pendingParts.length === 0) return

      const queue = [...pendingParts]
      let workerError: Error | null = null
      let pauseHit = false

      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          if (this.abortRequested || workerError) return

          // If paused, wait for resume
          if (this.paused) {
            pauseHit = true
            const shouldAbort = await this.waitIfPaused()
            if (shouldAbort) return
            // After resume, break out so we rebuild the queue from fresh state
            return
          }

          const partNumber = queue.shift()!

          // Skip if already completed (could happen after resume)
          if (this.completedParts.has(partNumber)) continue

          try {
            await this.uploadPartWithRetry(partNumber)
          } catch (error) {
            this.inFlightProgress.delete(partNumber)

            if (this.paused) {
              pauseHit = true
              return
            }
            if (this.abortRequested) return

            if (isCorsLikeError(error)) {
              try {
                await this.ensureBucketCors()
                await this.uploadPartWithRetry(partNumber)
                continue
              } catch {
                // fall through
              }
            }

            workerError =
              error instanceof Error ? error : new Error(String(error))
            return
          }

          this.inFlightProgress.delete(partNumber)
        }
      }

      const workerCount = Math.min(MAX_CONCURRENT_PARTS, pendingParts.length)
      const workers = Array.from({ length: workerCount }, () => worker())
      await Promise.all(workers)

      if (workerError) throw workerError
      if (this.abortRequested) return

      // If pause was hit, workers exited. Loop back to wait for resume,
      // rebuild queue, and continue.
      if (pauseHit) {
        const shouldAbort = await this.waitIfPaused()
        if (shouldAbort) return
        // Clear stale URLs since time may have passed
        this.urlCache.clear()
        // Loop continues: gets fresh pending parts and starts workers again
        continue
      }

      // All parts done
      return
    }
  }

  private async uploadPartWithRetry(partNumber: number): Promise<void> {
    const start = (partNumber - 1) * this.chunkSize
    const end = Math.min(this.config.file.size, start + this.chunkSize)
    const chunk = this.config.file.slice(start, end)

    for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt++) {
      if (this.abortRequested) return

      // Check pause before each attempt
      if (this.paused) throw new Error("paused")

      try {
        let url = this.urlCache.get(partNumber)
        if (!url || attempt > 1) {
          this.urlCache.delete(partNumber)
          await this.ensureUrlsAvailable(partNumber)
          url = this.urlCache.get(partNumber)!
        }

        const etag = await this.uploadBlob(url, chunk, (loaded, total) => {
          const fraction = Math.min(loaded / Math.max(total, 1), 1)
          this.inFlightProgress.set(partNumber, fraction)
          this.emitProgress()
        })

        if (etag) {
          this.completedParts.set(partNumber, etag)
          this.inFlightProgress.delete(partNumber)
          this.emitProgress()
          this.persistState()
          return
        }

        // ETag missing — treat as a retryable error
        throw new Error("Upload succeeded but ETag is missing from response")
      } catch (error) {
        this.inFlightProgress.delete(partNumber)

        // If paused or aborted, let the error propagate up for the worker to handle
        if (this.paused || this.abortRequested) {
          throw error
        }

        if (attempt === MAX_PART_RETRIES) {
          throw new Error(
            `Part ${partNumber} failed after ${MAX_PART_RETRIES} retries: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }

        const delay = Math.min(
          INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1),
          MAX_RETRY_DELAY_MS
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Batch URL fetching
  // ---------------------------------------------------------------------------

  private async ensureUrlsAvailable(partNumber: number): Promise<void> {
    if (this.urlFetchInFlight) {
      await this.urlFetchInFlight
      if (this.urlCache.has(partNumber)) return
    }

    const needed: number[] = []
    for (
      let i = partNumber;
      i <= this.totalParts && needed.length < BATCH_URL_SIZE;
      i++
    ) {
      if (!this.urlCache.has(i) && !this.completedParts.has(i)) {
        needed.push(i)
      }
    }

    if (needed.length === 0) return

    const fetchPromise = (async () => {
      const res = await fetch("/api/s3/upload/multipart/batch-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket: this.config.bucket,
          key: this.config.key,
          credentialId: this.config.credentialId,
          uploadId: this.uploadId,
          partNumbers: needed,
        }),
      })

      if (!res.ok) throw new Error("Failed to fetch batch URLs")

      const data = await res.json()
      for (const { partNumber: pn, url } of data.urls as Array<{
        partNumber: number
        url: string
      }>) {
        this.urlCache.set(pn, url)
      }
    })()

    this.urlFetchInFlight = fetchPromise
    try {
      await fetchPromise
    } finally {
      this.urlFetchInFlight = null
    }
  }

  // ---------------------------------------------------------------------------
  // XHR upload
  // ---------------------------------------------------------------------------

  private uploadBlob(
    url: string,
    blob: Blob,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      this.activeXHRs.add(xhr)

      xhr.open("PUT", url)
      xhr.setRequestHeader(
        "Content-Type",
        this.config.contentType || "application/octet-stream"
      )

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(event.loaded, event.total)
        }
      }

      xhr.onload = () => {
        this.activeXHRs.delete(xhr)
        if (xhr.status >= 200 && xhr.status < 300) {
          // Read ETag from header first; fall back to JSON body for proxy routes
          let etag = xhr.getResponseHeader("ETag")
          if (!etag && xhr.responseText) {
            try {
              const body = JSON.parse(xhr.responseText) as { ETag?: string }
              if (body.ETag) etag = body.ETag
            } catch {
              // not JSON, ignore
            }
          }
          resolve(etag)
        } else if (xhr.status === 0) {
          reject(
            new Error(
              "Upload failed due to CORS/network preflight. Ensure bucket CORS allows this app origin."
            )
          )
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`))
        }
      }

      xhr.onerror = () => {
        this.activeXHRs.delete(xhr)
        reject(
          new Error(
            "Upload failed due to CORS/network preflight. Ensure bucket CORS allows this app origin."
          )
        )
      }

      xhr.onabort = () => {
        this.activeXHRs.delete(xhr)
        reject(new Error("Upload aborted"))
      }

      xhr.send(blob)
    })
  }

  // ---------------------------------------------------------------------------
  // Complete multipart
  // ---------------------------------------------------------------------------

  private async completeMultipartUpload(): Promise<void> {
    this.setState("completing")

    const parts: Array<{ ETag: string; PartNumber: number }> = []
    for (const [partNumber, etag] of this.completedParts.entries()) {
      parts.push({ ETag: etag, PartNumber: partNumber })
    }
    parts.sort((a, b) => a.PartNumber - b.PartNumber)

    const res = await fetch("/api/s3/upload/multipart/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket: this.config.bucket,
        key: this.config.key,
        credentialId: this.config.credentialId,
        uploadId: this.uploadId,
        parts,
      }),
    })

    if (!res.ok) throw new Error("Failed to complete multipart upload")

    if (this.uploadId) {
      removeUploadState(this.uploadId)
    }

    this.cleanupNetworkListeners()
    this.setState("done")
    this.config.callbacks.onComplete()
  }

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------

  private async ensureBucketCors(): Promise<void> {
    const res = await fetch("/api/s3/cors/ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket: this.config.bucket,
        credentialId: this.config.credentialId,
        origin: typeof window !== "undefined" ? window.location.origin : "",
      }),
    })

    if (!res.ok) {
      throw new Error(
        "Upload blocked by bucket CORS. Could not auto-configure CORS with current credentials."
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Progress & speed
  // ---------------------------------------------------------------------------

  private emitProgress(): void {
    const fileSize = this.config.file.size

    let completed = 0
    for (const partNumber of this.completedParts.keys()) {
      completed += this.partSizes.get(partNumber) ?? 0
    }

    let inFlight = 0
    for (const [partNumber, fraction] of this.inFlightProgress.entries()) {
      const size = this.partSizes.get(partNumber) ?? 0
      inFlight += size * fraction
    }

    const totalUploaded = Math.min(completed + inFlight, fileSize)

    this.recordSpeedSample(totalUploaded)

    this.config.callbacks.onProgress(
      totalUploaded,
      fileSize,
      this.calculateSpeed()
    )
  }

  private recordSpeedSample(totalBytes: number): void {
    const now = Date.now()
    const last = this.speedSamples[this.speedSamples.length - 1]
    if (last && now === last.timestamp) {
      last.bytes = totalBytes
      return
    }

    this.speedSamples.push({ timestamp: now, bytes: totalBytes })
    const cutoff = now - SPEED_WINDOW_MS
    while (this.speedSamples.length > 0 && this.speedSamples[0].timestamp < cutoff) {
      this.speedSamples.shift()
    }
  }

  private calculateSpeed(): number {
    if (this.speedSamples.length < 2) return 0
    const oldest = this.speedSamples[0]
    const newest = this.speedSamples[this.speedSamples.length - 1]
    const elapsedMs = newest.timestamp - oldest.timestamp
    if (elapsedMs < 200) return 0
    const elapsed = elapsedMs / 1000
    return Math.max(0, (newest.bytes - oldest.bytes) / elapsed)
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private persistState(): void {
    if (!this.uploadId) return

    saveUploadState({
      uploadId: this.uploadId,
      bucket: this.config.bucket,
      key: this.config.key,
      credentialId: this.config.credentialId,
      fileName: this.config.file.name,
      fileSize: this.config.file.size,
      fileLastModified: this.config.file.lastModified,
      chunkSize: this.chunkSize,
      totalParts: this.totalParts,
      completedPartNumbers: Array.from(this.completedParts.keys()),
      createdAt: Date.now(),
    })
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  private setState(newState: UploadState): void {
    this.state = newState
    this.config.callbacks.onStateChange(newState)
  }

  // ---------------------------------------------------------------------------
  // Network listeners
  // ---------------------------------------------------------------------------

  private setupNetworkListeners(): void {
    if (typeof window === "undefined") return

    this.boundHandleOffline = () => {
      if (this.state === "uploading") {
        // Auto-pause on network loss (userPaused stays false for auto-resume)
        this.paused = true
        for (const xhr of this.activeXHRs) {
          xhr.abort()
        }
        this.activeXHRs.clear()
        this.inFlightProgress.clear()
        this.pauseGate = new Promise<void>((resolve) => {
          this.pauseGateResolve = resolve
        })
        this.setState("paused")
        this.emitProgress()
      }
    }

    this.boundHandleOnline = () => {
      if (this.state === "paused" && !this.userPaused) {
        this.onlineResumeTimer = setTimeout(() => {
          if (this.state === "paused" && !this.userPaused) {
            this.resume()
          }
        }, 2000)
      }
    }

    window.addEventListener("offline", this.boundHandleOffline)
    window.addEventListener("online", this.boundHandleOnline)
  }

  private cleanupNetworkListeners(): void {
    if (typeof window === "undefined") return

    if (this.boundHandleOffline) {
      window.removeEventListener("offline", this.boundHandleOffline)
    }
    if (this.boundHandleOnline) {
      window.removeEventListener("online", this.boundHandleOnline)
    }
    if (this.onlineResumeTimer) {
      clearTimeout(this.onlineResumeTimer)
    }
  }
}
