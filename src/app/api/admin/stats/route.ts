import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"

export async function GET() {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const [totalUsers, totalCredentials, tierCounts, totalFiles] =
    await Promise.all([
      prisma.user.count(),
      prisma.s3Credential.count(),
      prisma.user.groupBy({ by: ["tier"], _count: { _all: true } }),
      prisma.fileMetadata.count(),
    ])

  return NextResponse.json({
    totalUsers,
    totalCredentials,
    totalFiles,
    tierBreakdown: tierCounts.reduce(
      (acc, t) => ({ ...acc, [t.tier]: t._count._all }),
      {} as Record<string, number>
    ),
  })
}
