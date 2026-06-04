import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client, createS3ClientFromConfig } from "@/lib/s3"
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3"
import { testCredentialConnectionSchema } from "@/lib/validations"

type UnknownRecord = Record<string, unknown>
type PermissionState = "allowed" | "denied" | "not_tested" | "error"

interface CredentialPermissionSummary {
  endpoint: string
  provider: string
  region: string
  bucketCount: number
  sampleBuckets: string[]
  probeBucket?: string
  permissions: {
    listBuckets: PermissionState
    listObjects: PermissionState
    readObject: PermissionState
    putObject: PermissionState
    deleteObject: PermissionState
  }
  notes: string[]
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function getEndpointHostname(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined
  try {
    return new URL(endpoint).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function getErrorCode(error: unknown): string | undefined {
  const record = asRecord(error)
  const cause = asRecord(record?.cause)
  return asString(record?.Code) ?? asString(record?.code) ?? asString(cause?.code)
}

function isAccessDeniedError(error: unknown): boolean {
  const code = (getErrorCode(error) ?? asString(asRecord(error)?.name) ?? "").toUpperCase()
  return code === "ACCESSDENIED" || code === "UNAUTHORIZED" || code === "FORBIDDEN"
}

function getConnectionErrorDetails(error: unknown, endpoint: string | undefined): {
  message: string
  code?: string
  hint?: string
} {
  const record = asRecord(error)
  const cause = asRecord(record?.cause)

  const name = asString(record?.name)
  const code = asString(record?.Code) ?? asString(record?.code) ?? asString(cause?.code)
  const message = asString(record?.message) ?? "Connection failed"

  const normalizedSignal = (code ?? name ?? "").toUpperCase()
  const hostname = getEndpointHostname(endpoint)
  const isLocalHost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1"

  if (
    normalizedSignal === "ECONNREFUSED" ||
    normalizedSignal === "ETIMEDOUT" ||
    normalizedSignal === "ENOTFOUND" ||
    normalizedSignal === "EAI_AGAIN" ||
    normalizedSignal === "TIMEOUTERROR"
  ) {
    if (isLocalHost) {
      return {
        message,
        code: code ?? name,
        hint: "If the app runs in Docker, localhost points to the container. Use host.docker.internal or the MinIO service name instead.",
      }
    }

    return {
      message,
      code: code ?? name,
      hint: "Endpoint is unreachable. Check hostname, port, protocol (http/https), and network/firewall rules.",
    }
  }

  if (
    normalizedSignal === "SIGNATUREDOESNOTMATCH" ||
    normalizedSignal === "INVALIDACCESSKEYID" ||
    normalizedSignal === "INVALIDTOKEN"
  ) {
    return {
      message,
      code: code ?? name,
      hint: "Credential authentication failed. Verify access key, secret key, endpoint, and region.",
    }
  }

  if (normalizedSignal === "ACCESSDENIED") {
    return {
      message,
      code: code ?? name,
      hint: "Credentials connected but do not have permission for ListBuckets. Grant ListBuckets or test with a bucket-scoped operation.",
    }
  }

  if (
    normalizedSignal === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    normalizedSignal === "SELF_SIGNED_CERT_IN_CHAIN" ||
    normalizedSignal === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    normalizedSignal === "ERR_TLS_CERT_ALTNAME_INVALID"
  ) {
    return {
      message,
      code: code ?? name,
      hint: "TLS certificate is not trusted for this endpoint. Use a valid certificate or use http for local MinIO.",
    }
  }

  return { message, code: code ?? name }
}

async function buildCredentialPermissionSummary(
  client: S3Client,
  provider: string,
  endpoint: string,
  region: string
): Promise<CredentialPermissionSummary> {
  const summary: CredentialPermissionSummary = {
    endpoint,
    provider,
    region,
    bucketCount: 0,
    sampleBuckets: [],
    permissions: {
      listBuckets: "not_tested",
      listObjects: "not_tested",
      readObject: "not_tested",
      putObject: "not_tested",
      deleteObject: "not_tested",
    },
    notes: [],
  }

  let buckets: string[] = []
  try {
    const listBucketsResult = await client.send(new ListBucketsCommand({}))
    buckets = (listBucketsResult.Buckets ?? [])
      .map((bucket) => bucket.Name ?? "")
      .filter((name): name is string => Boolean(name))
    summary.permissions.listBuckets = "allowed"
  } catch (error) {
    if (isAccessDeniedError(error)) {
      summary.permissions.listBuckets = "denied"
      summary.notes.push("ListBuckets is denied for this credential.")
      return summary
    }
    summary.permissions.listBuckets = "error"
    throw error
  }

  summary.bucketCount = buckets.length
  summary.sampleBuckets = buckets.slice(0, 5)
  const probeBucket = buckets[0]
  if (!probeBucket) {
    summary.notes.push("No buckets visible for this credential, so object-level checks were skipped.")
    return summary
  }
  summary.probeBucket = probeBucket

  let probeObjectKey: string | undefined
  try {
    const listObjectsResult = await client.send(
      new ListObjectsV2Command({
        Bucket: probeBucket,
        MaxKeys: 1,
      })
    )
    summary.permissions.listObjects = "allowed"
    probeObjectKey = listObjectsResult.Contents?.[0]?.Key
  } catch (error) {
    summary.permissions.listObjects = isAccessDeniedError(error) ? "denied" : "error"
  }

  if (probeObjectKey) {
    try {
      await client.send(
        new HeadObjectCommand({
          Bucket: probeBucket,
          Key: probeObjectKey,
        })
      )
      summary.permissions.readObject = "allowed"
    } catch (error) {
      summary.permissions.readObject = isAccessDeniedError(error) ? "denied" : "error"
    }
  } else {
    summary.notes.push("No sample object found for read permission check.")
  }

  const probeWriteKey = `.s3admin/credential-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: probeBucket,
        Key: probeWriteKey,
        Body: "s3admin-credential-check",
        ContentType: "text/plain",
      })
    )
    summary.permissions.putObject = "allowed"

    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: probeBucket,
          Key: probeWriteKey,
        })
      )
      summary.permissions.deleteObject = "allowed"
    } catch (error) {
      summary.permissions.deleteObject = isAccessDeniedError(error) ? "denied" : "error"
      summary.notes.push(
        `Write probe object ${probeWriteKey} could not be deleted automatically. Remove it manually if needed.`
      )
    }
  } catch (error) {
    summary.permissions.putObject = isAccessDeniedError(error) ? "denied" : "error"
    summary.permissions.deleteObject = "not_tested"
  }

  return summary
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 })
  }

  let endpoint: string | undefined
  try {
    const { client, credential } = await getS3Client(session.user.id, id)
    endpoint = credential.endpoint
    const summary = await buildCredentialPermissionSummary(
      client,
      credential.provider,
      credential.endpoint,
      credential.region
    )
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    const details = getConnectionErrorDetails(error, endpoint)
    return NextResponse.json(
      {
        error: "Connection failed",
        message: details.message,
        code: details.code,
        hint: details.hint,
      },
      { status: 400 }
    )
  }
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json()
  const parsed = testCredentialConnectionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { provider, endpoint, region, accessKey, secretKey } = parsed.data
  let normalizedEndpoint: string | undefined
  try {
    const { client, endpoint: resolvedEndpoint, region: resolvedRegion } = createS3ClientFromConfig({
      endpoint,
      region,
      provider,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    })
    normalizedEndpoint = resolvedEndpoint
    const summary = await buildCredentialPermissionSummary(
      client,
      provider,
      resolvedEndpoint,
      resolvedRegion
    )
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    const details = getConnectionErrorDetails(error, normalizedEndpoint ?? endpoint)
    return NextResponse.json(
      {
        error: "Connection failed",
        message: details.message,
        code: details.code,
        hint: details.hint,
      },
      { status: 400 }
    )
  }
}
