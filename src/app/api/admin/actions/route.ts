import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import type { Prisma } from "@prisma/client"

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10))
  const limit = 50
  const skip = (page - 1) * limit

  const eventType = (searchParams.get("eventType") ?? "").trim()
  const query = (searchParams.get("q") ?? "").trim()

  const where: Prisma.UserActionEventWhereInput = {}

  if (eventType && eventType !== "all") {
    where.eventType = eventType
  }

  if (query) {
    where.OR = [
      { eventName: { contains: query, mode: "insensitive" } },
      { path: { contains: query, mode: "insensitive" } },
      { target: { contains: query, mode: "insensitive" } },
      { user: { email: { contains: query, mode: "insensitive" } } },
    ]
  }

  const [events, total] = await Promise.all([
    prisma.userActionEvent.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    }),
    prisma.userActionEvent.count({ where }),
  ])

  return NextResponse.json({ events, total, page, limit })
}
