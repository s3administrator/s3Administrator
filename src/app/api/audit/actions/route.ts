import { NextResponse } from "next/server"
import type { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import { getAuditCutoffDate, getAuditRetentionDays } from "@/lib/audit-retention"

const SORT_FIELDS = [
  "createdAt",
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
  const session = await auth()
  const userId = session?.user?.id

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const [user, entitlements] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    }),
    getUserPlanEntitlements(userId),
  ])

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const tier = entitlements?.slug ?? "free"
  const retentionDays = getAuditRetentionDays(tier)
  const retentionCutoff = getAuditCutoffDate(retentionDays)

  const { searchParams } = new URL(req.url)
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10))
  const requestedLimit = parseInt(searchParams.get("limit") ?? "50", 10)
  const limit = Number.isNaN(requestedLimit)
    ? 50
    : Math.max(10, Math.min(100, requestedLimit))
  const skip = (page - 1) * limit

  const query = safeQueryString(searchParams, "q", 120)
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

  const effectiveFrom =
    dateFrom && dateFrom > retentionCutoff ? dateFrom : retentionCutoff

  const whereAnd: Prisma.UserActionEventWhereInput[] = [
    { userId },
    {
      createdAt: {
        gte: effectiveFrom,
        lte: dateTo ?? undefined,
      },
    },
  ]

  if (eventType && eventType !== "all") {
    whereAnd.push({ eventType })
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

  if (query) {
    whereAnd.push({
      OR: [
        { eventType: { contains: query, mode: "insensitive" } },
        { eventName: { contains: query, mode: "insensitive" } },
        { path: { contains: query, mode: "insensitive" } },
        { method: { contains: query, mode: "insensitive" } },
        { target: { contains: query, mode: "insensitive" } },
        { ipAddress: { contains: query, mode: "insensitive" } },
      ],
    })
  }

  const where: Prisma.UserActionEventWhereInput = { AND: whereAnd }

  const [events, total] = await Promise.all([
    prisma.userActionEvent.findMany({
      where,
      skip,
      take: limit,
      orderBy: getOrderBy(sortBy, sortDir),
      select: {
        id: true,
        eventType: true,
        eventName: true,
        path: true,
        method: true,
        target: true,
        metadata: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
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
    retentionDays,
    tier,
    availableFrom: retentionCutoff.toISOString(),
  })
}
