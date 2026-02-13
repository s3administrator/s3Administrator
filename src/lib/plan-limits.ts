import { prisma } from "@/lib/db"
import type { PlanEntitlements } from "@/lib/plan-entitlements"

export interface BucketLimitViolation {
  bucketLimit: number
  currentBucketCount: number
}

export interface FileLimitViolation {
  fileLimit: number
  currentFileCount: number
  requestedAdditionalFiles: number
  availableSlots: number
}

export async function countIndexedBuckets(userId: string): Promise<number> {
  const buckets = await prisma.fileMetadata.groupBy({
    by: ["credentialId", "bucket"],
    where: { userId },
  })
  return buckets.length
}

export async function hasIndexedBucket(params: {
  userId: string
  credentialId: string
  bucket: string
}): Promise<boolean> {
  const existing = await prisma.fileMetadata.findFirst({
    where: {
      userId: params.userId,
      credentialId: params.credentialId,
      bucket: params.bucket,
    },
    select: { id: true },
  })

  return Boolean(existing)
}

export async function getBucketLimitViolation(params: {
  userId: string
  credentialId: string
  bucket: string
  entitlements: PlanEntitlements
}): Promise<BucketLimitViolation | null> {
  if (!Number.isFinite(params.entitlements.bucketLimit)) {
    return null
  }

  const alreadyIndexed = await hasIndexedBucket({
    userId: params.userId,
    credentialId: params.credentialId,
    bucket: params.bucket,
  })

  if (alreadyIndexed) {
    return null
  }

  const currentBucketCount = await countIndexedBuckets(params.userId)
  if (currentBucketCount >= params.entitlements.bucketLimit) {
    return {
      bucketLimit: params.entitlements.bucketLimit,
      currentBucketCount,
    }
  }

  return null
}

export async function getAdditionalFileLimitViolation(params: {
  userId: string
  requestedAdditionalFiles: number
  entitlements: PlanEntitlements
}): Promise<FileLimitViolation | null> {
  const requestedAdditionalFiles = Math.max(0, Math.floor(params.requestedAdditionalFiles))
  if (requestedAdditionalFiles <= 0 || !Number.isFinite(params.entitlements.fileLimit)) {
    return null
  }

  const currentFileCount = await prisma.fileMetadata.count({
    where: {
      userId: params.userId,
      isFolder: false,
    },
  })

  const availableSlots = Math.max(0, params.entitlements.fileLimit - currentFileCount)
  if (requestedAdditionalFiles > availableSlots) {
    return {
      fileLimit: params.entitlements.fileLimit,
      currentFileCount,
      requestedAdditionalFiles,
      availableSlots,
    }
  }

  return null
}
