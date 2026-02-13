import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const fileCount = await prisma.fileMetadata.count({
    where: {
      userId: session.user.id,
      isFolder: false,
    },
  })

  const bucketCount = await prisma.fileMetadata.groupBy({
    by: ["credentialId", "bucket"],
    where: { userId: session.user.id },
  })

  const entitlements = await getUserPlanEntitlements(session.user.id)

  return NextResponse.json({
    tier: entitlements?.slug ?? "free",
    fileCount,
    bucketCount: bucketCount.length,
  })
}
