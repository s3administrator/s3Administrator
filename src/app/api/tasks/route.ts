import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getTaskMissedScheduleGraceSeconds } from "@/lib/task-engine-config"
import { getUpcomingRunDates, normalizeExecutionHistory } from "@/lib/task-plans"
import {
  getEffectiveNextRunAtForTask,
  nextRunAtForTaskSchedule,
  resolveTaskSchedule,
  getUpcomingRunDatesFromCron,
} from "@/lib/task-schedule"

type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "canceled"

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { success, retryAfterSeconds } = rateLimitByUser(
      session.user.id,
      "tasks-list",
      30,
      60_000
    )
    if (!success) {
      return rateLimitResponse(retryAfterSeconds)
    }

    const scope = request.nextUrl.searchParams.get("scope") ?? "ongoing"
    const typeParam = request.nextUrl.searchParams.get("type")
    const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "8")
    const limitCap = typeParam ? 200 : 50
    const limit = Number.isFinite(limitRaw) ? Math.min(limitCap, Math.max(1, Math.floor(limitRaw))) : 8

    const statuses: TaskStatus[] =
      scope === "history"
        ? ["completed", "failed", "canceled"]
        : scope === "all"
          ? ["pending", "in_progress", "completed", "failed", "canceled"]
          : ["pending", "in_progress", "failed"]

    const ALLOWED_TYPES = new Set(["bulk_delete", "object_transfer"])
    const typeFilter = typeParam
      ? typeParam.split(",").filter((t) => ALLOWED_TYPES.has(t))
      : undefined

    const [tasks, cachedFiles] = await Promise.all([
      prisma.backgroundTask.findMany({
        where: {
          userId: session.user.id,
          status: {
            in: statuses,
          },
          ...(typeFilter && typeFilter.length > 0
            ? { type: { in: typeFilter } }
            : undefined),
        },
        orderBy: [
          {
            updatedAt: "desc",
          },
        ],
        take: limit,
        select: {
          id: true,
          type: true,
          title: true,
          status: true,
          progress: true,
          attempts: true,
          maxAttempts: true,
          runCount: true,
          lastError: true,
          lifecycleState: true,
          isRecurring: true,
          scheduleCron: true,
          scheduleIntervalSeconds: true,
          nextRunAt: true,
          lastRunAt: true,
          pausedAt: true,
          executionHistory: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
        },
      }),
      prisma.fileMetadata.count({
        where: {
          userId: session.user.id,
          isFolder: false,
        },
      }),
    ])

    const now = new Date()
    const scheduleDriftGraceMs = getTaskMissedScheduleGraceSeconds() * 1000
    const realignedNextRunAtByTaskId = new Map<string, Date>()

    await Promise.all(
      tasks.map(async (task) => {
        if (
          task.lifecycleState !== "active" ||
          task.status !== "pending" ||
          !task.isRecurring
        ) {
          return
        }

        const schedule = resolveTaskSchedule(task)
        if (!schedule.enabled) return

        const expectedNextRunAt = nextRunAtForTaskSchedule(schedule, now)
        if (!expectedNextRunAt) return

        if (task.nextRunAt.getTime() - expectedNextRunAt.getTime() <= scheduleDriftGraceMs) {
          return
        }

        const updated = await prisma.backgroundTask.updateMany({
          where: {
            id: task.id,
            userId: session.user.id,
            lifecycleState: "active",
            status: "pending",
            nextRunAt: task.nextRunAt,
          },
          data: {
            nextRunAt: expectedNextRunAt,
            lastError: null,
          },
        })

        if (updated.count > 0) {
          realignedNextRunAtByTaskId.set(task.id, expectedNextRunAt)
        }
      })
    )

    const normalizedTasks = tasks.map((task) => ({
      ...task,
      nextRunAt: realignedNextRunAtByTaskId.get(task.id) ?? task.nextRunAt,
    }))

    const taskIds = normalizedTasks.map((task) => task.id)
    let latestRuns: Array<{
      taskId: string
      status: string
      startedAt: Date
      finishedAt: Date | null
    }> = []
    let runCounts: Array<{
      taskId: string
      status: string
      _count: { _all: number }
    }> = []

    if (taskIds.length > 0) {
      try {
        ;[latestRuns, runCounts] = await Promise.all([
          prisma.backgroundTaskRun.findMany({
            where: {
              taskId: {
                in: taskIds,
              },
            },
            orderBy: [
              { taskId: "asc" },
              { runNumber: "desc" },
            ],
            distinct: ["taskId"],
            select: {
              taskId: true,
              status: true,
              startedAt: true,
              finishedAt: true,
            },
          }),
          prisma.backgroundTaskRun.groupBy({
            by: ["taskId", "status"],
            where: {
              taskId: {
                in: taskIds,
              },
            },
            _count: {
              _all: true,
            },
          }),
        ])
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? (error as { code?: string }).code
            : ""
        if (code !== "P2021") {
          throw error
        }
      }
    }

    const latestRunByTaskId = new Map(
      latestRuns.map((run) => [run.taskId, run])
    )
    const countsByTaskId = new Map<string, { successRuns: number; failedRuns: number }>()
    for (const row of runCounts) {
      const current = countsByTaskId.get(row.taskId) ?? { successRuns: 0, failedRuns: 0 }
      if (row.status === "succeeded") {
        current.successRuns += row._count._all
      } else if (row.status === "failed") {
        current.failedRuns += row._count._all
      }
      countsByTaskId.set(row.taskId, current)
    }

    const mappedTasks = normalizedTasks.map((task) => {
      const resolvedSchedule = resolveTaskSchedule(task)
      const isRecurringConfigured = task.isRecurring && resolvedSchedule.enabled
      const scheduleEnabled = task.lifecycleState === "active" && resolvedSchedule.enabled
      const effectiveNextRunAt = scheduleEnabled
        ? getEffectiveNextRunAtForTask(task, now)
        : task.nextRunAt

      return {
        ...task,
        isRecurring: isRecurringConfigured,
        scheduleCron: resolvedSchedule.cron,
        scheduleIntervalSeconds: resolvedSchedule.legacyIntervalSeconds,
        nextRunAt: effectiveNextRunAt,
        executionHistory: normalizeExecutionHistory(task.executionHistory),
        upcomingRuns: scheduleEnabled
          ? resolvedSchedule.cron
            ? getUpcomingRunDatesFromCron(resolvedSchedule.cron, effectiveNextRunAt, 3)
            : getUpcomingRunDates(effectiveNextRunAt, resolvedSchedule.legacyIntervalSeconds, 3)
          : [],
        lastRunStatus: latestRunByTaskId.get(task.id)?.status ?? null,
        lastRunDurationMs: (() => {
          const latest = latestRunByTaskId.get(task.id)
          if (!latest?.finishedAt) return null
          return Math.max(0, latest.finishedAt.getTime() - latest.startedAt.getTime())
        })(),
        successRuns: countsByTaskId.get(task.id)?.successRuns ?? 0,
        failedRuns: countsByTaskId.get(task.id)?.failedRuns ?? 0,
      }
    })

    return NextResponse.json({
      tasks: mappedTasks,
      summary: {
        cachedFiles,
      },
    })
  } catch (error) {
    console.error("Failed to list tasks:", error)
    const message = error instanceof Error ? error.message : "Failed to list tasks"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
