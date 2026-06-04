import { NextRequest, NextResponse } from "next/server"
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  type BucketLocationConstraint,
  type CreateBucketCommandInput,
} from "@aws-sdk/client-s3"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { getS3ErrorCode, getS3ErrorMessage } from "@/lib/task-process-shared"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { bucketManageSchema } from "@/lib/validations"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import { rebuildUserExtensionStats } from "@/lib/file-stats"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"

interface ListedBucket {
  name: string
  creationDate: string | null
  credentialId: string
  credentialLabel: string
  provider: string
}

interface UserCredentialRef {
  id: string
  label: string
  provider: string
}

type S3ClientInstance = Awaited<ReturnType<typeof getS3Client>>["client"]

const LIST_BUCKETS_TIMEOUT_MS = 8_000
const BUCKET_LIST_CACHE_TTL_MS = 30_000
const BUCKET_LIST_STALE_TTL_MS = 5 * 60 * 1000

interface CachedBucketListEntry {
  freshUntil: number
  staleUntil: number
  buckets: ListedBucket[]
}

const bucketListCache = new Map<string, CachedBucketListEntry>()

function buildBucketListCacheKey(userId: string, scope: string): string {
  return `${userId}:${scope}`
}

function readCachedBucketList(
  cacheKey: string,
  now: number,
  allowStale = false
): ListedBucket[] | null {
  const cached = bucketListCache.get(cacheKey)
  if (!cached) return null
  if (cached.freshUntil > now) return cached.buckets
  if (allowStale && cached.staleUntil > now) return cached.buckets
  bucketListCache.delete(cacheKey)
  return null
}

function writeCachedBucketList(cacheKey: string, buckets: ListedBucket[]): ListedBucket[] {
  const now = Date.now()
  bucketListCache.set(cacheKey, {
    freshUntil: now + BUCKET_LIST_CACHE_TTL_MS,
    staleUntil: now + BUCKET_LIST_STALE_TTL_MS,
    buckets,
  })
  return buckets
}

function invalidateCachedBucketLists(userId: string) {
  const prefix = `${userId}:`
  for (const cacheKey of bucketListCache.keys()) {
    if (cacheKey.startsWith(prefix)) {
      bucketListCache.delete(cacheKey)
    }
  }
}

function isTimeoutStyleS3Error(error: unknown): boolean {
  const code = getS3ErrorCode(error)
  if (code === "ETIMEDOUT" || code === "TimeoutError" || code === "AbortError") {
    return true
  }

  const message = getS3ErrorMessage(error).toLowerCase()
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborterror")
  )
}

async function listBucketsWithTimeout(client: S3ClientInstance) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), LIST_BUCKETS_TIMEOUT_MS)

  try {
    return await client.send(new ListBucketsCommand({}), {
      abortSignal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function listBucketsForCredential(params: {
  userId: string
  credential: UserCredentialRef
  client?: S3ClientInstance
  bypassCache?: boolean
}): Promise<ListedBucket[]> {
  const cacheKey = buildBucketListCacheKey(params.userId, `credential:${params.credential.id}`)
  const now = Date.now()
  if (!params.bypassCache) {
    const cached = readCachedBucketList(cacheKey, now)
    if (cached) return cached
  }

  const client =
    params.client ?? (await getS3Client(params.userId, params.credential.id)).client

  try {
    const response = await listBucketsWithTimeout(client)

    return writeCachedBucketList(
      cacheKey,
      (response.Buckets ?? [])
        .map((bucket) => ({
          name: bucket.Name ?? "",
          creationDate: bucket.CreationDate?.toISOString() ?? null,
          credentialId: params.credential.id,
          credentialLabel: params.credential.label,
          provider: params.credential.provider,
        }))
        .filter((bucket) => bucket.name.length > 0)
    )
  } catch (error) {
    const stale = params.bypassCache ? null : readCachedBucketList(cacheKey, now, true)
    if (stale && isTimeoutStyleS3Error(error)) {
      console.warn(`Using stale bucket cache for credential ${params.credential.id}:`, error)
      return stale
    }
    throw error
  }
}

async function listBucketsAcrossCredentials(
  userId: string,
  options?: { bypassCache?: boolean }
): Promise<ListedBucket[]> {
  const cacheKey = buildBucketListCacheKey(userId, "all")
  const now = Date.now()
  if (!options?.bypassCache) {
    const cached = readCachedBucketList(cacheKey, now)
    if (cached) return cached
  }

  const credentials = await prisma.s3Credential.findMany({
    where: { userId },
    select: {
      id: true,
      label: true,
      provider: true,
    },
    orderBy: { createdAt: "asc" },
  })

  const allBuckets: ListedBucket[] = []
  const seenBucketNames = new Set<string>()
  let successCount = 0

  const results = await Promise.allSettled(
    credentials.map((credential) =>
      listBucketsForCredential({
        userId,
        credential,
        bypassCache: options?.bypassCache,
      })
    )
  )

  for (const [index, result] of results.entries()) {
    const credential = credentials[index]
    if (!credential) continue

    if (result.status !== "fulfilled") {
      console.warn(`Failed to list buckets for credential ${credential.id}:`, result.reason)
      continue
    }

    successCount += 1
    for (const bucket of result.value) {
      if (seenBucketNames.has(bucket.name)) continue
      seenBucketNames.add(bucket.name)
      allBuckets.push(bucket)
    }
  }

  if (successCount === 0) {
    const stale = options?.bypassCache ? null : readCachedBucketList(cacheKey, now, true)
    if (stale) {
      console.warn(`Using stale bucket cache for user ${userId} after live bucket listing failed`)
      return stale
    }

    if (credentials.length > 0) {
      throw new Error("Failed to list buckets for every configured credential")
    }
  }

  return writeCachedBucketList(cacheKey, allBuckets)
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const limitResult = rateLimitByUser(session.user.id, "s3-buckets-list", 120, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const { searchParams } = request.nextUrl
    const all = searchParams.get("all") === "true"
    const credentialId = searchParams.get("credentialId")

    if (credentialId || !all) {
      const { client, credential } = await getS3Client(session.user.id, credentialId || undefined)
      const buckets = await listBucketsForCredential({
        userId: session.user.id,
        credential: {
          id: credential.id,
          label: credential.label,
          provider: credential.provider,
        },
        client,
      })

      return NextResponse.json({ buckets })
    }

    const buckets = await listBucketsAcrossCredentials(session.user.id)
    return NextResponse.json({ buckets })
  } catch (error) {
    console.error("Failed to list buckets:", error)
    return NextResponse.json({ error: "Failed to list buckets" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-bucket-create", 20, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const body = await request.json()
    const parsed = bucketManageSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId } = parsed.data
    auditBucket = bucket

    const entitlements = await getUserPlanEntitlements(session.user.id)
    if (!entitlements) {
      return NextResponse.json({ error: "Failed to resolve plan entitlements" }, { status: 403 })
    }

    const existingBuckets = await listBucketsAcrossCredentials(session.user.id, {
      bypassCache: true,
    })
    if (
      Number.isFinite(entitlements.bucketLimit) &&
      !existingBuckets.some((item) => item.name === bucket) &&
      existingBuckets.length >= entitlements.bucketLimit
    ) {
      return NextResponse.json(
        {
          error: "Bucket limit reached for current plan",
          details: {
            bucketLimit: entitlements.bucketLimit,
            currentBucketCount: existingBuckets.length,
            plan: entitlements.slug,
            planSource: entitlements.source,
          },
        },
        { status: 400 }
      )
    }

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    const createInput: CreateBucketCommandInput = { Bucket: bucket }

    if (credential.provider === "AWS" && credential.region !== "us-east-1") {
      createInput.CreateBucketConfiguration = {
        LocationConstraint: credential.region as BucketLocationConstraint,
      }
    }

    await client.send(new CreateBucketCommand(createInput))
    invalidateCachedBucketLists(session.user.id)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "bucket_create",
      path: "/api/s3/buckets",
      method: "POST",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        provider: credential.provider,
      },
      ...requestContext,
    })

    return NextResponse.json({
      created: true,
      bucket,
      credentialId: credential.id,
    })
  } catch (error) {
    console.error("Failed to create bucket:", error)

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "bucket_create_failed",
        path: "/api/s3/buckets",
        method: "POST",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          error: getS3ErrorMessage(error),
          code: getS3ErrorCode(error) || null,
        },
        ...requestContext,
      })
    }

    const code = getS3ErrorCode(error)
    if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") {
      return NextResponse.json(
        { error: "Bucket already exists" },
        { status: 409 }
      )
    }

    return NextResponse.json({ error: "Failed to create bucket" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditCredentialId = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-bucket-delete", 20, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const body = await request.json()
    const parsed = bucketManageSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId } = parsed.data
    auditBucket = bucket

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    auditCredentialId = credential.id

    const preview = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: 1,
      })
    )

    if ((preview.KeyCount ?? 0) > 0 || (preview.Contents?.length ?? 0) > 0) {
      return NextResponse.json(
        { error: "Bucket must be empty before deletion" },
        { status: 400 }
      )
    }

    await client.send(
      new DeleteBucketCommand({
        Bucket: bucket,
      })
    )

    await prisma.fileMetadata.deleteMany({
      where: {
        userId: session.user.id,
        credentialId: credential.id,
        bucket,
      },
    })

    await rebuildUserExtensionStats(session.user.id)
    invalidateCachedBucketLists(session.user.id)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "bucket_delete",
      path: "/api/s3/buckets",
      method: "DELETE",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        provider: credential.provider,
      },
      ...requestContext,
    })

    return NextResponse.json({
      deleted: true,
      bucket,
      credentialId: credential.id,
    })
  } catch (error) {
    console.error("Failed to delete bucket:", error)

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "bucket_delete_failed",
        path: "/api/s3/buckets",
        method: "DELETE",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          credentialId: auditCredentialId || null,
          error: getS3ErrorMessage(error),
          code: getS3ErrorCode(error) || null,
        },
        ...requestContext,
      })
    }

    const code = getS3ErrorCode(error)
    if (code === "BucketNotEmpty") {
      return NextResponse.json(
        { error: "Bucket must be empty before deletion" },
        { status: 400 }
      )
    }
    if (code === "NoSuchBucket") {
      return NextResponse.json({ error: "Bucket not found" }, { status: 404 })
    }
    if (code.includes("AccessDenied") || code.includes("Unauthorized")) {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 })
    }

    return NextResponse.json({ error: "Failed to delete bucket" }, { status: 500 })
  }
}
