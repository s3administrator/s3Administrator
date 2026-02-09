import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

function toNumber(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const now = new Date()
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const since14d = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)

  const [
    totalUsers,
    totalCredentials,
    tierCounts,
    totalFiles,
    totalEvents,
    eventsLast24h,
    eventsLast7d,
    signInsLast7d,
    apiCallsLast24h,
    activeUsersLast24hRows,
    activeUsersLast7dRows,
    topEventTypesRaw,
    topPathsRaw,
    dailyEventsRaw,
    apiErrorsLast24hRaw,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.s3Credential.count(),
    prisma.user.groupBy({ by: ["tier"], _count: { _all: true } }),
    prisma.fileMetadata.count(),
    prisma.userActionEvent.count(),
    prisma.userActionEvent.count({ where: { createdAt: { gte: since24h } } }),
    prisma.userActionEvent.count({ where: { createdAt: { gte: since7d } } }),
    prisma.userActionEvent.count({
      where: {
        createdAt: { gte: since7d },
        eventType: "auth",
        eventName: "sign_in",
      },
    }),
    prisma.userActionEvent.count({
      where: {
        createdAt: { gte: since24h },
        eventType: "api_call",
      },
    }),
    prisma.userActionEvent.findMany({
      where: {
        createdAt: { gte: since24h },
        userId: { not: null },
      },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.userActionEvent.findMany({
      where: {
        createdAt: { gte: since7d },
        userId: { not: null },
      },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.userActionEvent.groupBy({
      by: ["eventType"],
      where: { createdAt: { gte: since7d } },
      _count: { eventType: true },
      orderBy: { _count: { eventType: "desc" } },
      take: 8,
    }),
    prisma.userActionEvent.groupBy({
      by: ["path"],
      where: { createdAt: { gte: since7d } },
      _count: { path: true },
      orderBy: { _count: { path: "desc" } },
      take: 8,
    }),
    prisma.$queryRaw<Array<{ day: Date | string; count: bigint | number }>>`
      SELECT date_trunc('day', "createdAt") AS "day", COUNT(*)::bigint AS "count"
      FROM "UserActionEvent"
      WHERE "createdAt" >= ${since14d}
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    prisma.$queryRaw<Array<{ errorCount: bigint | number }>>`
      SELECT COUNT(*)::bigint AS "errorCount"
      FROM "UserActionEvent"
      WHERE "eventType" = 'api_call'
        AND "createdAt" >= ${since24h}
        AND CASE
          WHEN "metadata" IS NULL THEN FALSE
          WHEN ("metadata"->>'status') ~ '^[0-9]+$' THEN (("metadata"->>'status')::int >= 400)
          ELSE FALSE
        END
    `,
  ])

  const dailyMap = new Map<string, number>()
  for (const row of dailyEventsRaw) {
    const key = new Date(row.day).toISOString().slice(0, 10)
    dailyMap.set(key, toNumber(row.count))
  }

  const startOfToday = new Date(now)
  startOfToday.setUTCHours(0, 0, 0, 0)
  const dailyEventsLast14d = Array.from({ length: 14 }, (_, index) => {
    const day = new Date(startOfToday)
    day.setUTCDate(startOfToday.getUTCDate() - (13 - index))
    const date = day.toISOString().slice(0, 10)
    return {
      date,
      count: dailyMap.get(date) ?? 0,
    }
  })

  const apiErrorsLast24h = toNumber(apiErrorsLast24hRaw[0]?.errorCount)
  const apiErrorRateLast24h =
    apiCallsLast24h > 0
      ? Number(((apiErrorsLast24h / apiCallsLast24h) * 100).toFixed(2))
      : 0

  return NextResponse.json({
    totalUsers,
    totalCredentials,
    totalFiles,
    totalEvents,
    tierBreakdown: tierCounts.reduce(
      (acc, t) => ({ ...acc, [t.tier]: t._count._all }),
      {} as Record<string, number>
    ),
    actionMetrics: {
      eventsLast24h,
      eventsLast7d,
      activeUsersLast24h: activeUsersLast24hRows.length,
      activeUsersLast7d: activeUsersLast7dRows.length,
      signInsLast7d,
      apiCallsLast24h,
      apiErrorsLast24h,
      apiErrorRateLast24h,
    },
    topEventTypesLast7d: topEventTypesRaw.map((row) => ({
      label: row.eventType,
      count: row._count.eventType,
    })),
    topPathsLast7d: topPathsRaw.map((row) => ({
      label: row.path,
      count: row._count.path,
    })),
    dailyEventsLast14d,
  })
}
