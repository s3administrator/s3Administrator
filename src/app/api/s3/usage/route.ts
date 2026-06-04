import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const [fileCount, bucketGroups, storageAgg, entitlements] = await Promise.all([
    prisma.fileMetadata.count({
      where: { userId: session.user.id, isFolder: false },
    }),
    prisma.fileMetadata.groupBy({
      by: ["credentialId", "bucket"],
      where: { userId: session.user.id },
    }),
    prisma.fileMetadata.aggregate({
      where: { userId: session.user.id, isFolder: false },
      _sum: { size: true },
    }),
    getUserPlanEntitlements(session.user.id),
  ])

  const fileLimit = entitlements && Number.isFinite(entitlements.fileLimit) ? entitlements.fileLimit : null
  const bucketLimit = entitlements && Number.isFinite(entitlements.bucketLimit) ? entitlements.bucketLimit : null
  const storageLimitBytes = entitlements && Number.isFinite(entitlements.storageLimitBytes) ? entitlements.storageLimitBytes : null

  return NextResponse.json({
    tier: entitlements?.slug ?? "free",
    fileCount,
    fileLimit,
    bucketCount: bucketGroups.length,
    bucketLimit,
    storageBytes: Number(storageAgg._sum.size ?? 0),
    storageLimitBytes,
  })
}
