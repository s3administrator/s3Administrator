import { Agent as HttpAgent } from "node:http"
import { Agent as HttpsAgent } from "node:https"
import { S3Client } from "@aws-sdk/client-s3"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import { prisma } from "@/lib/db"
import { decrypt } from "@/lib/crypto"
import { quietAwsLogger } from "@/lib/aws-logger"

export type S3TrafficClass = "interactive" | "background"

interface S3ClientOptions {
  trafficClass?: S3TrafficClass
}

function createS3HttpHandler(maxSockets: number): NodeHttpHandler {
  return new NodeHttpHandler({
    connectionTimeout: 5_000,
    requestTimeout: 0,
    httpsAgent: new HttpsAgent({
      maxSockets,
      keepAlive: true,
      keepAliveMsecs: 30_000,
    }),
    httpAgent: new HttpAgent({
      maxSockets,
      keepAlive: true,
      keepAliveMsecs: 30_000,
    }),
  })
}

function parseS3IntEnv(key: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[key]
  if (!raw) return defaultValue
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.min(max, Math.max(min, parsed))
}

const S3_INTERACTIVE_MAX_SOCKETS = parseS3IntEnv("S3_INTERACTIVE_MAX_SOCKETS", 24, 4, 128)
const S3_BACKGROUND_MAX_SOCKETS = parseS3IntEnv("S3_BACKGROUND_MAX_SOCKETS", 32, 4, 128)

const s3HttpHandlerByTrafficClass: Record<S3TrafficClass, NodeHttpHandler> = {
  interactive: createS3HttpHandler(S3_INTERACTIVE_MAX_SOCKETS),
  background: createS3HttpHandler(S3_BACKGROUND_MAX_SOCKETS),
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"])
const S3_CLIENT_CACHE_TTL_MS = 5 * 60 * 1000
const S3_CLIENT_CACHE_MAX_ENTRIES = parseS3IntEnv("S3_CLIENT_CACHE_MAX_ENTRIES", 48, 8, 256)

interface CachedS3ClientEntry {
  expiresAt: number
  value: {
    client: S3Client
    credential: {
      id: string
      endpoint: string
      region: string
      provider: string
      label: string
    }
  }
}

const s3ClientCache = new Map<string, CachedS3ClientEntry>()

function hasProtocol(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function normalizeS3Endpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) {
    throw new Error("Endpoint is required")
  }

  let withProtocol = trimmed
  if (!hasProtocol(withProtocol)) {
    const hostPort = withProtocol.split("/")[0] || withProtocol
    const hostname = hostPort.split(":")[0]?.toLowerCase() || ""
    const protocol = LOCAL_HOSTNAMES.has(hostname) ? "http" : "https"
    withProtocol = `${protocol}://${withProtocol}`
  }

  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw new Error("Endpoint must be a valid URL")
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Endpoint protocol must be http or https")
  }

  return parsed.toString().replace(/\/+$/, "")
}

/**
 * Providers whose S3-compatible API uses a fixed signing region
 * regardless of the regional endpoint URL selected by the user.
 * The region the user chose is still stored and used for endpoint
 * construction, but the SDK signing region must be overridden.
 */
const FIXED_SIGNING_REGION_PROVIDERS: Record<string, string> = {
  STORADERA: "us-east-1",
}

export function normalizeS3Region(provider: string, region: string | null | undefined): string {
  const normalizedRegion = region?.trim() ?? ""
  if (normalizedRegion) return normalizedRegion

  const normalizedProvider = provider.trim().toUpperCase()
  if (normalizedProvider === "MINIO" || normalizedProvider === "GENERIC") {
    return "us-east-1"
  }

  throw new Error("Region is required for this provider")
}

/**
 * Return the signing region the SDK should use.
 * Some S3-compatible providers ignore the region in SigV4 and always
 * expect a fixed value (typically "us-east-1").
 */
export function getSigningRegion(provider: string, region: string): string {
  const override = FIXED_SIGNING_REGION_PROVIDERS[provider.trim().toUpperCase()]
  return override ?? region
}

export function createS3ClientFromConfig(config: {
  endpoint: string
  region: string | null | undefined
  provider: string
  accessKeyId: string
  secretAccessKey: string
}, options?: S3ClientOptions): {
  client: S3Client
  endpoint: string
  region: string
} {
  const trafficClass = options?.trafficClass ?? "interactive"
  const endpoint = normalizeS3Endpoint(config.endpoint)
  const region = normalizeS3Region(config.provider, config.region)
  const signingRegion = getSigningRegion(config.provider, region)
  const client = new S3Client({
    endpoint,
    region: signingRegion,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
    // S3-compatible providers may reject optional checksum features on presigned GET URLs.
    // Keep checksum behavior to required-only for broad compatibility.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    logger: quietAwsLogger,
    requestHandler: s3HttpHandlerByTrafficClass[trafficClass],
  })

  return { client, endpoint, region }
}

export async function getS3Client(
  userId: string,
  credentialId?: string,
  options?: S3ClientOptions
): Promise<{
  client: S3Client
  credential: {
    id: string
    endpoint: string
    region: string
    provider: string
    label: string
  }
}> {
  const trafficClass = options?.trafficClass ?? "interactive"
  const cacheKey = credentialId
    ? `${userId}:${credentialId}:${trafficClass}`
    : `${userId}:default:${trafficClass}`
  const now = Date.now()
  const cached = s3ClientCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    s3ClientCache.delete(cacheKey)
    s3ClientCache.set(cacheKey, cached)
    return cached.value
  }
  if (cached) {
    s3ClientCache.delete(cacheKey)
  }

  let credential = await prisma.s3Credential.findFirst({
    where: credentialId
      ? { id: credentialId, userId }
      : { userId, isDefault: true },
  })

  // Fall back to any credential for this user when no default is set
  if (!credential && !credentialId) {
    credential = await prisma.s3Credential.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    })
  }

  if (!credential) {
    throw new Error("No S3 credentials configured")
  }

  const accessKey = decrypt(credential.accessKeyEnc, credential.ivAccessKey)
  const secretKey = decrypt(credential.secretKeyEnc, credential.ivSecretKey)
  const { client, endpoint, region } = createS3ClientFromConfig({
    endpoint: credential.endpoint,
    region: credential.region,
    provider: credential.provider,
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
  }, options)

  const value = {
    client,
    credential: {
      id: credential.id,
      endpoint,
      region,
      provider: credential.provider,
      label: credential.label,
    },
  }

  if (s3ClientCache.size >= S3_CLIENT_CACHE_MAX_ENTRIES) {
    const oldestKey = s3ClientCache.keys().next().value
    if (oldestKey) {
      s3ClientCache.delete(oldestKey)
    }
  }

  s3ClientCache.set(cacheKey, {
    expiresAt: now + S3_CLIENT_CACHE_TTL_MS,
    value,
  })

  return value
}
