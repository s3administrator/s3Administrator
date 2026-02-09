import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { FILE_TYPE_EXTENSIONS } from "@/lib/file-search"

const TYPE_KEYS = ["image", "video", "audio", "document", "archive", "code", "other"] as const

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
      }))
      .sort((a, b) => {
        if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount
        if (b.totalSize !== a.totalSize) return b.totalSize - a.totalSize
        return TYPE_KEYS.indexOf(a.type) - TYPE_KEYS.indexOf(b.type)
      })

    return NextResponse.json({
      summary: {
        indexedBucketCount: buckets.length,
        indexedFileCount: fileAggregate._count._all,
        indexedTotalSize: toNumber(fileAggregate._sum.size),
        distinctExtensionCount: extensionStats.length,
        lastIndexedAt: fileAggregate._max.lastModified?.toISOString() ?? null,
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
