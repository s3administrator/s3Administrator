import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { success, retryAfterSeconds } = rateLimitByUser(
    session.user.id,
    "task-events-list",
    30,
    60_000
  )
  if (!success) {
    return rateLimitResponse(retryAfterSeconds)
  }

  const { taskId } = await params
  if (!taskId || typeof taskId !== "string") {
    return NextResponse.json({ error: "Invalid task ID" }, { status: 400 })
  }

  const task = await prisma.backgroundTask.findFirst({
    where: { id: taskId, userId: session.user.id },
    select: { id: true },
  })
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 })
  }

  const url = new URL(request.url)
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50))
  const filter = url.searchParams.get("filter") ?? null
  const runId = url.searchParams.get("runId") ?? null
  const includeProgressRaw = (url.searchParams.get("includeProgress") ?? "").trim().toLowerCase()
  const includeProgress =
    includeProgressRaw === "1" ||
    includeProgressRaw === "true" ||
    includeProgressRaw === "yes" ||
    includeProgressRaw === "on"

  const baseWhere = {
    taskId,
    userId: session.user.id,
    ...(runId ? { runId } : {}),
  }

  const fileWhere = {
    ...baseWhere,
    ...(filter
      ? { eventType: filter }
      : includeProgress
        ? { eventType: { startsWith: "file_" } }
        : { eventType: { startsWith: "file_", not: "file_progress" } }),
  }

  const [events, total, rawCounts, progressFileCountRows] = await Promise.all([
    prisma.backgroundTaskEvent.findMany({
      where: fileWhere,
      orderBy: { at: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        eventType: true,
        message: true,
        metadata: true,
        at: true,
      },
    }),
    prisma.backgroundTaskEvent.count({ where: fileWhere }),
    prisma.backgroundTaskEvent.groupBy({
      by: ["eventType"],
      where: {
        ...baseWhere,
        eventType: includeProgress
          ? { startsWith: "file_" }
          : { startsWith: "file_", not: "file_progress" },
      },
      _count: true,
    }),
    includeProgress
      ? prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(DISTINCT NULLIF(e."metadata"->>'sourceKey', ''))::bigint AS count
          FROM "BackgroundTaskEvent" e
          WHERE e."taskId" = ${taskId}
            AND e."userId" = ${session.user.id}
            ${runId ? Prisma.sql`AND e."runId" = ${runId}` : Prisma.empty}
            AND e."eventType" = 'file_progress'
        `)
      : Promise.resolve([{ count: BigInt(0) }]),
  ])

  const counts: Record<string, number> = {}
  for (const row of rawCounts) {
    counts[row.eventType] = row._count
  }
  if (includeProgress) {
    counts.file_progress = Number(progressFileCountRows[0]?.count ?? BigInt(0))
  }

  return NextResponse.json({
    events,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    counts,
  })
}
