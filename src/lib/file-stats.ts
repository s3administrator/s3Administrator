import { prisma } from "@/lib/db"

interface UserExtensionStatsDeltaEntry {
  extension: string
  size: bigint
}

export function getObjectExtension(key: string, isFolder: boolean): string {
  if (isFolder) return ""

  const normalized = key.endsWith("/") ? key.slice(0, -1) : key
  const filename = normalized.split("/").pop() ?? normalized
  const dotIndex = filename.lastIndexOf(".")

  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return ""
  }

  return filename.slice(dotIndex + 1).toLowerCase()
}

export async function rebuildUserExtensionStats(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const grouped = await tx.fileMetadata.groupBy({
      by: ["extension"],
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
    })

    await tx.userFileExtensionStat.deleteMany({
      where: { userId },
    })

    if (grouped.length > 0) {
      await tx.userFileExtensionStat.createMany({
        data: grouped.map((entry) => ({
          userId,
          extension: entry.extension,
          fileCount: entry._count._all,
          totalSize: entry._sum.size ?? BigInt(0),
        })),
      })
    }
  })
}

export async function applyUserExtensionStatsDelta(
  userId: string,
  entries: UserExtensionStatsDeltaEntry[]
): Promise<void> {
  if (entries.length === 0) return

  const deltaByExtension = new Map<string, { fileCount: number; totalSize: bigint }>()
  for (const entry of entries) {
    const normalizedExtension = entry.extension ?? ""
    const current = deltaByExtension.get(normalizedExtension) ?? {
      fileCount: 0,
      totalSize: BigInt(0),
    }
    current.fileCount += 1
    current.totalSize += entry.size
    deltaByExtension.set(normalizedExtension, current)
  }

  const extensions = Array.from(deltaByExtension.keys())

  await prisma.$transaction(async (tx) => {
    const existing = await tx.userFileExtensionStat.findMany({
      where: {
        userId,
        extension: {
          in: extensions,
        },
      },
      select: {
        extension: true,
        fileCount: true,
        totalSize: true,
      },
    })

    const existingByExtension = new Map(
      existing.map((entry) => [entry.extension, entry])
    )

    for (const [extension, delta] of deltaByExtension) {
      const current = existingByExtension.get(extension)
      if (!current) {
        continue
      }

      const nextFileCount = Math.max(0, current.fileCount - delta.fileCount)
      const nextTotalSize = current.totalSize > delta.totalSize
        ? current.totalSize - delta.totalSize
        : BigInt(0)

      if (nextFileCount === 0) {
        await tx.userFileExtensionStat.deleteMany({
          where: {
            userId,
            extension,
          },
        })
        continue
      }

      await tx.userFileExtensionStat.update({
        where: {
          userId_extension: {
            userId,
            extension,
          },
        },
        data: {
          fileCount: nextFileCount,
          totalSize: nextTotalSize,
        },
      })
    }
  })
}
