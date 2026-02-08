import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { prisma } from "@/lib/db"
import { getTierLimits } from "@/lib/tiers"
import { ListObjectsV2Command } from "@aws-sdk/client-s3"

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { bucket } = body

    if (!bucket) {
      return NextResponse.json(
        { error: "bucket is required" },
        { status: 400 }
      )
    }

    // Get user's tier and limits
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tier: true },
    })

    const tierLimits = getTierLimits(user?.tier ?? "free")

    const { client, credential } = await getS3Client(session.user.id)

    // Get current cached file count for this user across all buckets
    const currentCachedCount = await prisma.fileMetadata.count({
      where: {
        userId: session.user.id,
        credentialId: credential.id,
      },
    })

    // Count files in other buckets (to know how many slots are left for this bucket)
    const otherBucketCount = await prisma.fileMetadata.count({
      where: {
        userId: session.user.id,
        credentialId: credential.id,
        bucket: { not: bucket },
      },
    })

    const availableSlots = Math.max(0, tierLimits.files - otherBucketCount)

    // Paginate through all objects in the bucket
    const s3Objects: { key: string; size: number; lastModified: Date; isFolder: boolean }[] = []
    let continuationToken: string | undefined

    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      )

      for (const obj of response.Contents ?? []) {
        if (!obj.Key) continue

        s3Objects.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? new Date(),
          isFolder: obj.Key.endsWith("/") && (obj.Size ?? 0) === 0,
        })
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined
    } while (continuationToken)

    const totalInS3 = s3Objects.length

    // Limit entries to tier allowance
    const objectsToSync = s3Objects.slice(0, availableSlots)

    // Upsert entries into FileMetadata
    let synced = 0
    for (const obj of objectsToSync) {
      await prisma.fileMetadata.upsert({
        where: {
          credentialId_bucket_key: {
            credentialId: credential.id,
            bucket,
            key: obj.key,
          },
        },
        create: {
          userId: session.user.id,
          credentialId: credential.id,
          bucket,
          key: obj.key,
          size: BigInt(obj.size),
          lastModified: obj.lastModified,
          isFolder: obj.isFolder,
        },
        update: {
          size: BigInt(obj.size),
          lastModified: obj.lastModified,
          isFolder: obj.isFolder,
        },
      })
      synced++
    }

    // Delete FileMetadata entries for objects no longer in S3
    const s3KeySet = new Set(s3Objects.map((o) => o.key))
    const cachedEntries = await prisma.fileMetadata.findMany({
      where: {
        userId: session.user.id,
        credentialId: credential.id,
        bucket,
      },
      select: { id: true, key: true },
    })

    const staleIds = cachedEntries
      .filter((entry) => !s3KeySet.has(entry.key))
      .map((entry) => entry.id)

    if (staleIds.length > 0) {
      await prisma.fileMetadata.deleteMany({
        where: { id: { in: staleIds } },
      })
    }

    return NextResponse.json({ synced, total: totalInS3 })
  } catch (error) {
    console.error("Failed to sync metadata:", error)
    const message = error instanceof Error ? error.message : "Failed to sync metadata"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
