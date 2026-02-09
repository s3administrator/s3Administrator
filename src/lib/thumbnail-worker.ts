import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pipeline } from "node:stream/promises"
import ffmpeg from "fluent-ffmpeg"
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3"

class Semaphore {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private readonly maxConcurrency: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1
      return () => this.release()
    }

    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active += 1
    return () => this.release()
  }

  private release() {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next) next()
  }
}

const thumbnailSemaphore = new Semaphore(2)

function ffmpegStillFrame(inputPath: string, outputPath: string, offset: string, maxWidth: number, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const vf = `scale='min(${maxWidth},iw)':-2`
    let settled = false

    const command = ffmpeg(inputPath)
      .inputOptions(["-ss", offset])
      .outputOptions([
        "-vframes", "1",
        "-vf", vf,
        "-f", "webp",
      ])
      .on("end", () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })
      .on("error", (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      .save(outputPath)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      command.kill("SIGKILL")
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
}

async function saveS3ObjectToFile(client: S3Client, bucket: string, key: string, targetPath: string) {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  )

  if (!response.Body) {
    throw new Error("Source object body is empty")
  }

  const body = response.Body as {
    pipe?: (dest: ReturnType<typeof createWriteStream>) => unknown
    transformToByteArray?: () => Promise<Uint8Array>
  }

  if (typeof body.pipe === "function") {
    await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(targetPath))
    return
  }

  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray()
    await writeFile(targetPath, Buffer.from(bytes))
    return
  }

  throw new Error("Unsupported S3 object body stream type")
}

export async function generateVideoThumbnail(params: {
  client: S3Client
  bucket: string
  key: string
  maxWidth: number
  timeoutMs: number
}): Promise<{ buffer: Buffer; mimeType: string; durationMs: number }> {
  const release = await thumbnailSemaphore.acquire()
  const startedAt = Date.now()
  let workDir = ""

  try {
    workDir = await mkdtemp(join(tmpdir(), "s3-thumb-"))
    const sourcePath = join(workDir, "source-video")
    const thumbPath = join(workDir, "thumb.webp")

    await saveS3ObjectToFile(params.client, params.bucket, params.key, sourcePath)

    try {
      await ffmpegStillFrame(sourcePath, thumbPath, "00:00:01", params.maxWidth, params.timeoutMs)
    } catch {
      await ffmpegStillFrame(sourcePath, thumbPath, "00:00:00", params.maxWidth, params.timeoutMs)
    }

    const buffer = await readFile(thumbPath)
    return {
      buffer,
      mimeType: "image/webp",
      durationMs: Date.now() - startedAt,
    }
  } finally {
    release()
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
