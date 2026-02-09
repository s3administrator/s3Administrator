import { createHash } from "node:crypto"
import { S3Client, CopyObjectCommand, DeleteObjectsCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { envVar } from "@/lib/env"

let cachedThumbnailClient: S3Client | null = null

function requireValue(name: string, value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return trimmed
}

export function getThumbnailBucketName(): string {
  return requireValue("THUMBNAIL_S3_BUCKET", envVar("THUMBNAIL_S3_BUCKET"))
}

export function getThumbnailUrlTtlSeconds(): number {
  const raw = envVar("THUMBNAIL_URL_TTL_SECONDS")
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 3600
  return Math.min(86400, parsed)
}

export function getThumbnailMaxWidth(): number {
  const raw = envVar("THUMBNAIL_MAX_WIDTH")
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 64) return 480
  return Math.min(2048, parsed)
}

export function getThumbnailStorageClient(): S3Client {
  if (cachedThumbnailClient) {
    return cachedThumbnailClient
  }

  const endpoint = requireValue("THUMBNAIL_S3_ENDPOINT", envVar("THUMBNAIL_S3_ENDPOINT"))
  const region = requireValue("THUMBNAIL_S3_REGION", envVar("THUMBNAIL_S3_REGION"))
  const accessKey = requireValue("THUMBNAIL_S3_ACCESS_KEY", envVar("THUMBNAIL_S3_ACCESS_KEY"))
  const secretKey = requireValue("THUMBNAIL_S3_SECRET_KEY", envVar("THUMBNAIL_S3_SECRET_KEY"))

  cachedThumbnailClient = new S3Client({
    endpoint,
    region,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: true,
  })

  return cachedThumbnailClient
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export function buildThumbnailObjectKey(input: {
  userId: string
  credentialId: string
  bucket: string
  key: string
  sourceLastModified: Date
  sourceSize: bigint
}): string {
  const bucketHash = sha256(input.bucket).slice(0, 16)
  const sourceHash = sha256(
    `${input.key}|${input.sourceLastModified.toISOString()}|${input.sourceSize.toString()}`
  )
  return `thumb/v1/${input.userId}/${input.credentialId}/${bucketHash}/${sourceHash}.webp`
}

export async function uploadThumbnailObject(params: {
  key: string
  body: Buffer
  contentType?: string
}) {
  const client = getThumbnailStorageClient()
  const bucket = getThumbnailBucketName()
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType ?? "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
    })
  )
}

export async function deleteThumbnailObjects(keys: string[]) {
  if (keys.length === 0) return

  const client = getThumbnailStorageClient()
  const bucket = getThumbnailBucketName()

  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    )
  }
}

export async function copyThumbnailObject(oldKey: string, newKey: string) {
  const client = getThumbnailStorageClient()
  const bucket = getThumbnailBucketName()

  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: newKey,
      CopySource: encodeURIComponent(`${bucket}/${oldKey}`),
      CacheControl: "public, max-age=31536000, immutable",
      MetadataDirective: "REPLACE",
      ContentType: "image/webp",
    })
  )
}
