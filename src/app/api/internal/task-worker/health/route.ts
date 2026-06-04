import { NextResponse } from "next/server"
import { prisma } from "@/lib/db"
import { getTaskEngineInternalToken, isTaskEngineV2Enabled } from "@/lib/task-engine-config"

export const runtime = "nodejs"

function isAuthorized(request: Request): boolean {
  const token = getTaskEngineInternalToken()
  if (!token) return false
  const requestToken = (request.headers.get("x-task-engine-token") ?? "").trim()
  return requestToken.length > 0 && requestToken === token
}

export async function GET(request: Request) {
  if (!isTaskEngineV2Enabled()) {
    return NextResponse.json({
      enabled: false,
      message: "Task engine v2 is disabled",
    })
  }

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = new Date()
  let failedRunsLastHour = 0
  const [dueCount, inProgressCount, oldestDueTask] = await Promise.all([
    prisma.backgroundTask.count({
      where: {
        lifecycleState: "active",
        status: {
          in: ["pending", "in_progress"],
        },
        nextRunAt: {
          lte: now,
        },
      },
    }),
    prisma.backgroundTask.count({
      where: {
        lifecycleState: "active",
        status: "in_progress",
      },
    }),
    prisma.backgroundTask.findFirst({
      where: {
        lifecycleState: "active",
        status: {
          in: ["pending", "in_progress"],
        },
        nextRunAt: {
          lte: now,
        },
      },
      orderBy: {
        nextRunAt: "asc",
      },
      select: {
        id: true,
        userId: true,
        nextRunAt: true,
      },
    }),
  ])

  try {
    failedRunsLastHour = await prisma.backgroundTaskRun.count({
      where: {
        status: "failed",
        startedAt: {
          gte: new Date(Date.now() - 60 * 60 * 1000),
        },
      },
    })
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : ""
    if (code !== "P2021") {
      throw error
    }
  }

  const queueLagMs = oldestDueTask
    ? Math.max(0, Date.now() - oldestDueTask.nextRunAt.getTime())
    : 0

  return NextResponse.json({
    enabled: true,
    dueCount,
    inProgressCount,
    failedRunsLastHour,
    queueLagMs,
    oldestDueTask: oldestDueTask
      ? {
        id: oldestDueTask.id,
        userId: oldestDueTask.userId,
        nextRunAt: oldestDueTask.nextRunAt.toISOString(),
      }
      : null,
  })
}
