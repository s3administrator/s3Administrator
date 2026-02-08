import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { tier: true },
  })

  const fileCount = await prisma.fileMetadata.count({
    where: { userId: session.user.id },
  })

  const bucketCount = await prisma.fileMetadata.groupBy({
    by: ["bucket"],
    where: { userId: session.user.id },
  })

  return NextResponse.json({
    tier: user?.tier ?? "free",
    fileCount,
    bucketCount: bucketCount.length,
  })
}
