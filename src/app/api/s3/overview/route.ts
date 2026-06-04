import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { FILE_TYPE_EXTENSIONS } from "@/lib/file-search"
import { getS3Client } from "@/lib/s3"
import { scanIncompleteMultipart } from "@/lib/s3-multipart-incomplete"

const TYPE_KEYS = ["image", "video", "audio", "document", "archive", "code", "other"] as const
const MULTIPART_SCAN_CONCURRENCY = 3

type OverviewType = typeof TYPE_KEYS[number]

function toNumber(value: bigint | null | undefined): number {
  if (typeof value === "bigint") return Number(value)
  return Number(value ?? 0)
}

const extensionToType = new Map<string, OverviewType>()
for (const [type, extensions] of Object.entries(FILE_TYPE_EXTENSIONS)) {
  if (type === "other") continue
  for (const extension of extensions) {
    extensionToType.set(extension, type as OverviewType)
  }
}

function getTypeFromExtension(extension: string): OverviewType {
  if (!extension) return "other"
  return extensionToType.get(extension.toLowerCase()) ?? "other"
}

function getTypeFromObjectKey(key: string): OverviewType {
  const fileName = key.split("/").pop() ?? key
  if (!fileName) return "other"
  const dotIndex = fileName.lastIndexOf(".")
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return "other"
  }
  const extension = fileName.slice(dotIndex + 1)
  return getTypeFromExtension(extension)
}

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = session.user.id

    const [bucketGroups, extensionStats, fileAggregate] = await Promise.all([
      prisma.fileMetadata.groupBy({
        by: ["bucket", "credentialId"],
        where: {
          userId,
          isFolder: false,
        },
        _count: {
          _all: true,
        },
        _sum: {
          size: true,
        },
      }),
      prisma.userFileExtensionStat.findMany({
        where: { userId },
        select: {
          extension: true,
          fileCount: true,
          totalSize: true,
        },
        orderBy: [
          { fileCount: "desc" },
          { totalSize: "desc" },
        ],
      }),
      prisma.fileMetadata.aggregate({
        where: {
          userId,
          isFolder: false,
        },
        _count: {
          _all: true,
        },
        _sum: {
          size: true,
        },
        _max: {
          lastModified: true,
        },
      }),
    ])

    const multipartTypeAggregates = new Map<
      OverviewType,
      { uploads: number; parts: number; totalSize: number }
    >(TYPE_KEYS.map((type) => [type, { uploads: 0, parts: 0, totalSize: 0 }]))

    let multipartUploads = 0
    let multipartParts = 0
    let multipartTotalSize = 0
    let multipartScannedBuckets = 0
    let multipartFailedBuckets = 0

    const multipartTargets = bucketGroups.map((entry) => ({
      bucket: entry.bucket,
      credentialId: entry.credentialId,
    }))

    if (multipartTargets.length > 0) {
      const clientPromiseByCredential = new Map<string, ReturnType<typeof getS3Client>>()
      let nextTargetIndex = 0
      const workerCount = Math.min(MULTIPART_SCAN_CONCURRENCY, multipartTargets.length)

      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          const targetIndex = nextTargetIndex
          nextTargetIndex += 1

          if (targetIndex >= multipartTargets.length) {
            break
          }

          const target = multipartTargets[targetIndex]
          if (!target) continue

          try {
            const existingClientPromise = clientPromiseByCredential.get(target.credentialId)
            const clientPromise =
              existingClientPromise ??
              getS3Client(userId, target.credentialId, {
                trafficClass: "background",
              })

            if (!existingClientPromise) {
              clientPromiseByCredential.set(target.credentialId, clientPromise)
            }

            const { client } = await clientPromise
            const scan = await scanIncompleteMultipart(client, target.bucket, true)

            multipartScannedBuckets += 1
            multipartUploads += scan.summary.uploads
            multipartParts += scan.summary.parts
            multipartTotalSize += scan.summary.incompleteSize

            for (const upload of scan.uploads) {
              const type = getTypeFromObjectKey(upload.key)
              const typeAggregate = multipartTypeAggregates.get(type)
              if (!typeAggregate) continue

              typeAggregate.uploads += 1
              typeAggregate.parts += upload.partCount
              typeAggregate.totalSize += upload.size
            }
          } catch (error) {
            multipartFailedBuckets += 1
            const bucketName = target.bucket
            const credentialId = target.credentialId
            console.warn(
              `Failed to scan incomplete multipart uploads for ${credentialId}:${bucketName}:`,
              error
            )
          }
        }
      })

      await Promise.all(workers)
    }

    const credentialIds = Array.from(new Set(bucketGroups.map((entry) => entry.credentialId)))
    const credentials = credentialIds.length > 0
      ? await prisma.s3Credential.findMany({
        where: {
          userId,
          id: {
            in: credentialIds,
          },
        },
        select: {
          id: true,
          label: true,
        },
      })
      : []

    const credentialLabels = new Map(credentials.map((credential) => [credential.id, credential.label]))

    const buckets = bucketGroups
      .map((entry) => ({
        bucket: entry.bucket,
        credentialId: entry.credentialId,
        credentialLabel: credentialLabels.get(entry.credentialId) ?? "Unknown",
        fileCount: entry._count._all,
        totalSize: toNumber(entry._sum.size),
      }))
      .sort((a, b) => {
        if (b.totalSize !== a.totalSize) return b.totalSize - a.totalSize
        if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount
        if (a.bucket !== b.bucket) return a.bucket.localeCompare(b.bucket)
        return a.credentialLabel.localeCompare(b.credentialLabel)
      })

    const extensions = extensionStats
      .map((entry) => ({
        extension: entry.extension,
        fileCount: entry.fileCount,
        totalSize: toNumber(entry.totalSize),
        type: getTypeFromExtension(entry.extension),
      }))
      .sort((a, b) => {
        if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount
        if (b.totalSize !== a.totalSize) return b.totalSize - a.totalSize
        return a.extension.localeCompare(b.extension)
      })

    const typeAggregates = new Map<OverviewType, { fileCount: number; totalSize: number }>(
      TYPE_KEYS.map((type) => [type, { fileCount: 0, totalSize: 0 }])
    )

    for (const extension of extensions) {
      const current = typeAggregates.get(extension.type)
      if (!current) continue
      current.fileCount += extension.fileCount
      current.totalSize += extension.totalSize
    }

    const types = TYPE_KEYS
      .map((type) => ({
        type,
        fileCount: typeAggregates.get(type)?.fileCount ?? 0,
        totalSize: typeAggregates.get(type)?.totalSize ?? 0,
        multipartIncompleteUploads: multipartTypeAggregates.get(type)?.uploads ?? 0,
        multipartIncompleteParts: multipartTypeAggregates.get(type)?.parts ?? 0,
        multipartIncompleteSize: multipartTypeAggregates.get(type)?.totalSize ?? 0,
      }))
      .sort((a, b) => {
        if (b.multipartIncompleteSize !== a.multipartIncompleteSize) {
          return b.multipartIncompleteSize - a.multipartIncompleteSize
        }
        if (b.totalSize !== a.totalSize) return b.totalSize - a.totalSize
        if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount
        return TYPE_KEYS.indexOf(a.type) - TYPE_KEYS.indexOf(b.type)
      })

    return NextResponse.json({
      summary: {
        indexedBucketCount: buckets.length,
        indexedFileCount: fileAggregate._count._all,
        indexedTotalSize: toNumber(fileAggregate._sum.size),
        distinctExtensionCount: extensionStats.length,
        lastIndexedAt: fileAggregate._max.lastModified?.toISOString() ?? null,
        multipartIncomplete: {
          uploads: multipartUploads,
          parts: multipartParts,
          totalSize: multipartTotalSize,
          scannedBuckets: multipartScannedBuckets,
          failedBuckets: multipartFailedBuckets,
        },
      },
      buckets,
      extensions,
      types,
    })
  } catch (error) {
    console.error("Failed to build dashboard overview:", error)
    return NextResponse.json({ error: "Failed to build dashboard overview" }, { status: 500 })
  }
}
