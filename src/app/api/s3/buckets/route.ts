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

function getS3ErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return ""
  const candidate = error as { Code?: unknown; code?: unknown; name?: unknown }
  if (typeof candidate.Code === "string") return candidate.Code
  if (typeof candidate.code === "string") return candidate.code
  if (typeof candidate.name === "string") return candidate.name
  return ""
}

function getS3ErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "S3 operation failed"
  const candidate = error as { message?: unknown; Message?: unknown }
  if (typeof candidate.message === "string") return candidate.message
  if (typeof candidate.Message === "string") return candidate.Message
  return "S3 operation failed"
}

async function listBucketsForCredential(params: {
  userId: string
  credential: UserCredentialRef
}): Promise<ListedBucket[]> {
  const { client } = await getS3Client(params.userId, params.credential.id)
  const response = await client.send(new ListBucketsCommand({}))

  return (response.Buckets ?? [])
    .map((bucket) => ({
      name: bucket.Name ?? "",
      creationDate: bucket.CreationDate?.toISOString() ?? null,
      credentialId: params.credential.id,
      credentialLabel: params.credential.label,
      provider: params.credential.provider,
    }))
    .filter((bucket) => bucket.name.length > 0)
}

async function listBucketsAcrossCredentials(userId: string): Promise<ListedBucket[]> {
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

  for (const credential of credentials) {
    try {
      const buckets = await listBucketsForCredential({
        userId,
        credential,
      })

      for (const bucket of buckets) {
        if (seenBucketNames.has(bucket.name)) continue
        seenBucketNames.add(bucket.name)
        allBuckets.push(bucket)
      }
    } catch (error) {
      console.warn(`Failed to list buckets for credential ${credential.id}:`, error)
    }
  }

  return allBuckets
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
      const response = await client.send(new ListBucketsCommand({}))

      const buckets: ListedBucket[] = (response.Buckets ?? [])
        .map((bucket) => ({
          name: bucket.Name ?? "",
          creationDate: bucket.CreationDate?.toISOString() ?? null,
          credentialId: credential.id,
          credentialLabel: credential.label,
          provider: credential.provider,
        }))
        .filter((bucket) => bucket.name.length > 0)

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

    const existingBuckets = await listBucketsAcrossCredentials(session.user.id)
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

    await prisma.$transaction(async (tx) => {
      await tx.fileMetadata.deleteMany({
        where: {
          userId: session.user.id,
          credentialId: credential.id,
          bucket,
        },
      })

      await tx.mediaThumbnail.deleteMany({
        where: {
          userId: session.user.id,
          credentialId: credential.id,
          bucket,
        },
      })
    })

    await rebuildUserExtensionStats(session.user.id)

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
