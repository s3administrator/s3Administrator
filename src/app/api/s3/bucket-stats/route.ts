import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = request.nextUrl
    const all = searchParams.get("all") === "true"
    const credentialId = searchParams.get("credentialId")

    // Build where clause based on parameters
    let whereClause: any = {
      userId: session.user.id,
      isFolder: false,
    }

    if (credentialId) {
      whereClause.credentialId = credentialId
    } else if (!all) {
      // Default: only use the default credential
      const defaultCred = await prisma.s3Credential.findFirst({
        where: { userId: session.user.id, isDefault: true },
        select: { id: true },
      })
      if (!defaultCred) {
        return NextResponse.json({ buckets: [] })
      }
      whereClause.credentialId = defaultCred.id
    }

    const stats = await prisma.fileMetadata.groupBy({
      by: ["bucket", "credentialId"],
      where: whereClause,
      _sum: { size: true },
      _count: { _all: true },
    })

    const buckets = stats.map((s) => ({
      name: s.bucket,
      totalSize: Number(s._sum.size ?? 0),
      fileCount: s._count._all,
      credentialId: s.credentialId,
    }))

    return NextResponse.json({ buckets })
  } catch (error) {
    console.error("Failed to get bucket stats:", error)
    return NextResponse.json({ error: "Failed to get bucket stats" }, { status: 500 })
  }
}
