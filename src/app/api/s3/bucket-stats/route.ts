import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const stats = await prisma.fileMetadata.groupBy({
      by: ["bucket"],
      where: {
        userId: session.user.id,
        isFolder: false,
      },
      _sum: { size: true },
      _count: { _all: true },
    })

    const buckets = stats.map((s) => ({
      name: s.bucket,
      totalSize: Number(s._sum.size ?? 0),
      fileCount: s._count._all,
    }))

    return NextResponse.json({ buckets })
  } catch (error) {
    console.error("Failed to get bucket stats:", error)
    return NextResponse.json({ error: "Failed to get bucket stats" }, { status: 500 })
  }
}
