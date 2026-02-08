import { prisma } from "@/lib/db"

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
