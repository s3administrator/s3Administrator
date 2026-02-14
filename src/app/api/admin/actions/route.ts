import { NextResponse } from "next/server"
import { communityGuard } from "@/lib/api-guard";
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import type { Prisma } from "@prisma/client"

const SORT_FIELDS = [
  "createdAt",
  "user",
  "eventType",
  "eventName",
  "path",
  "method",
  "target",
  "ipAddress",
] as const

type SortField = (typeof SORT_FIELDS)[number]

function safeQueryString(searchParams: URLSearchParams, key: string, max = 255) {
  const value = (searchParams.get(key) ?? "").trim()
  if (!value) return ""
  return value.slice(0, max)
}

function parseSortField(raw: string): SortField {
  return (SORT_FIELDS as readonly string[]).includes(raw)
    ? (raw as SortField)
    : "createdAt"
}

function parseSortDirection(raw: string): Prisma.SortOrder {
  return raw === "asc" ? "asc" : "desc"
}

function parseDateStart(value: string): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

function parseDateEnd(value: string): Date | null {
  const start = parseDateStart(value)
  if (!start) return null
  const end = new Date(start)
  end.setUTCHours(23, 59, 59, 999)
  return end
}

function getOrderBy(
  sortField: SortField,
  sortDirection: Prisma.SortOrder
): Prisma.UserActionEventOrderByWithRelationInput[] {
  switch (sortField) {
    case "user":
      return [{ user: { email: sortDirection } }, { createdAt: "desc" }]
    case "createdAt":
      return [{ createdAt: sortDirection }]
    case "eventType":
      return [{ eventType: sortDirection }, { createdAt: "desc" }]
    case "eventName":
      return [{ eventName: sortDirection }, { createdAt: "desc" }]
    case "path":
      return [{ path: sortDirection }, { createdAt: "desc" }]
    case "method":
      return [{ method: sortDirection }, { createdAt: "desc" }]
    case "target":
      return [{ target: sortDirection }, { createdAt: "desc" }]
    case "ipAddress":
      return [{ ipAddress: sortDirection }, { createdAt: "desc" }]
    default:
      return [{ createdAt: "desc" }]
  }
}

export async function GET(req: Request) {
  const _guard = communityGuard(); if (_guard) return _guard;
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10))
  const requestedLimit = parseInt(searchParams.get("limit") ?? "50", 10)
  const limit = Number.isNaN(requestedLimit)
    ? 50
    : Math.max(10, Math.min(100, requestedLimit))
  const skip = (page - 1) * limit

  const query = safeQueryString(searchParams, "q", 120)
  const user = safeQueryString(searchParams, "user", 120)
  const eventType = safeQueryString(searchParams, "eventType", 64)
  const eventName = safeQueryString(searchParams, "eventName", 120)
  const path = safeQueryString(searchParams, "path", 512)
  const method = safeQueryString(searchParams, "method", 16)
  const target = safeQueryString(searchParams, "target", 512)
  const ipAddress = safeQueryString(searchParams, "ipAddress", 64)
  const dateFrom = parseDateStart(safeQueryString(searchParams, "dateFrom", 32))
  const dateTo = parseDateEnd(safeQueryString(searchParams, "dateTo", 32))
  const sortBy = parseSortField(safeQueryString(searchParams, "sortBy", 24))
  const sortDir = parseSortDirection(safeQueryString(searchParams, "sortDir", 8))

  const whereAnd: Prisma.UserActionEventWhereInput[] = []

  if (eventType && eventType !== "all") {
    whereAnd.push({ eventType })
  }
  if (user) {
    whereAnd.push({
      user: {
        OR: [
          { email: { contains: user, mode: "insensitive" } },
          { name: { contains: user, mode: "insensitive" } },
        ],
      },
    })
  }
  if (eventName) {
    whereAnd.push({ eventName: { contains: eventName, mode: "insensitive" } })
  }
  if (path) {
    whereAnd.push({ path: { contains: path, mode: "insensitive" } })
  }
  if (method && method !== "all") {
    whereAnd.push({ method: { contains: method, mode: "insensitive" } })
  }
  if (target) {
    whereAnd.push({ target: { contains: target, mode: "insensitive" } })
  }
  if (ipAddress) {
    whereAnd.push({ ipAddress: { contains: ipAddress, mode: "insensitive" } })
  }
  if (dateFrom || dateTo) {
    whereAnd.push({
      createdAt: {
        gte: dateFrom ?? undefined,
        lte: dateTo ?? undefined,
      },
    })
  }

  if (query) {
    whereAnd.push({
      OR: [
        { eventType: { contains: query, mode: "insensitive" } },
        { eventName: { contains: query, mode: "insensitive" } },
        { path: { contains: query, mode: "insensitive" } },
        { method: { contains: query, mode: "insensitive" } },
        { target: { contains: query, mode: "insensitive" } },
        { ipAddress: { contains: query, mode: "insensitive" } },
        {
          user: {
            OR: [
              { email: { contains: query, mode: "insensitive" } },
              { name: { contains: query, mode: "insensitive" } },
            ],
          },
        },
      ],
    })
  }

  const where: Prisma.UserActionEventWhereInput =
    whereAnd.length > 0 ? { AND: whereAnd } : {}

  const [events, total] = await Promise.all([
    prisma.userActionEvent.findMany({
      where,
      skip,
      take: limit,
      orderBy: getOrderBy(sortBy, sortDir),
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

  return NextResponse.json({
    events,
    total,
    page,
    limit,
    sortBy,
    sortDir,
  })
}
