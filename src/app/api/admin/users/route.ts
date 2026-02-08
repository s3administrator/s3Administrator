import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const page = parseInt(searchParams.get("page") ?? "1", 10)
  const limit = 20
  const skip = (page - 1) * limit

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        tier: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        createdAt: true,
        _count: {
          select: { s3Credentials: true, fileMetadata: true },
        },
      },
    }),
    prisma.user.count(),
  ])

  return NextResponse.json({ users, total, page, limit })
}
