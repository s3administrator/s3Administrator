import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db"
import { auth } from "@/lib/auth"
import { logUserAuditAction } from "@/lib/audit-logger"
import {
  getTaskEngineInternalToken,
  getTaskMaxActivePerUser,
  getTaskGlobalMaxActive,
  getTaskMissedScheduleGraceSeconds,
} from "@/lib/task-engine-config"
import {
  normalizeExecutionHistory,
  type TaskExecutionHistoryEntry,
} from "@/lib/task-plans"
import {
  nextRunAtForTaskSchedule,
  resolveTaskSchedule,
  type ResolvedTaskSchedule,
} from "@/lib/task-schedule"
import {
  type ObjectTransferTaskPayload,
  LOCK_SECONDS,
  SYNC_POLL_INTERVAL_SECONDS,
  addTaskHistoryEntry,
  buildProcessedResponse,
  snapshotFromCheckpoint,
  formatTaskProcessingError,
  persistClaimedTaskCheckpoint,
  parseObjectTransferPayload,
  resolveTaskPlanPayload,
  realignFutureRecurringRun,
} from "@/lib/task-process-shared"
import { processObjectTransferTask } from "@/lib/task-process-transfer"
import { processBulkDeleteTask } from "@/lib/task-process-bulk-delete"

export const runtime = "nodejs"
export const maxDuration = 300

const MAX_STALE_SCHEDULE_SKIPS_PER_CALL = 32

export async function POST(request: Request) {
  let claimedTask:
    | {
        id: string
        type: string
        runCount: number
        attempts: number
        maxAttempts: number
      }
    | null = null
  let userId: string | null = null
  let transferPayload: ObjectTransferTaskPayload | null = null
  let taskExecutionHistory: TaskExecutionHistoryEntry[] = []
  let claimedTaskSchedule: ResolvedTaskSchedule | null = null

  try {
    const internalToken = getTaskEngineInternalToken()
    const requestToken = (request.headers.get("x-task-engine-token") ?? "").trim()
    const requestedUserId = (new URL(request.url).searchParams.get("userId") ?? "").trim()

    if (internalToken && requestToken === internalToken && requestedUserId) {
      userId = requestedUserId
    } else {
      const session = await auth()
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      }
      userId = session.user.id
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const actorUserId = userId

    const TASK_TYPES = ["bulk_delete", "object_transfer"] as const
    const requestedType = (new URL(request.url).searchParams.get("type") ?? "").trim()
    const typeFilter = requestedType && TASK_TYPES.includes(requestedType as typeof TASK_TYPES[number])
      ? [requestedType]
      : [...TASK_TYPES]

    const now = new Date()
    const maxActive = getTaskMaxActivePerUser()

    // Per-type concurrency: each type gets a reserved share of the total slots
    // so one type (e.g. bulk_delete) can never starve another (e.g. object_transfer).
    // Reserved slots = floor(maxActive / number_of_types), minimum 1.
    // Remaining slots are available to any type on a first-come basis.
    const typeCount = TASK_TYPES.length
    const reservedPerType = Math.max(1, Math.floor(maxActive / typeCount))

    const lockedByType = await prisma.backgroundTask.groupBy({
      by: ["type"],
      where: {
        userId: actorUserId,
        lifecycleState: "active",
        status: "in_progress",
        nextRunAt: { gt: now },
      },
      _count: { _all: true },
    })

    const lockedCounts = new Map(lockedByType.map((r) => [r.type, r._count._all]))
    const totalLocked = lockedByType.reduce((sum, r) => sum + r._count._all, 0)
    const requestedTypeName = typeFilter.length === 1 ? typeFilter[0] : null
    const lockedForRequestedType = requestedTypeName ? (lockedCounts.get(requestedTypeName) ?? 0) : totalLocked

    // Block if: this type already used its reserved slots AND overall limit is reached
    if (totalLocked >= maxActive && lockedForRequestedType >= reservedPerType) {
      return NextResponse.json({
        processed: false,
        message: "Task concurrency limit reached for user",
      })
    }

    // Global throughput cap: when set, limit the total number of in_progress
    // tasks across all users to prevent resource exhaustion under load.
    const globalMax = getTaskGlobalMaxActive()
    if (globalMax > 0) {
      const globalLocked = await prisma.backgroundTask.count({
        where: {
          status: "in_progress",
          lifecycleState: "active",
          nextRunAt: { gt: now },
        },
      })
      if (globalLocked >= globalMax) {
        return NextResponse.json({
          processed: false,
          message: "Global task concurrency limit reached",
        })
      }
    }

    // Recover tasks stuck in cancel-transition: lifecycleState was set to
    // "canceled" while the task was in_progress, but the worker never
    // finalised the status (crash, timeout, etc.).  Once the lock
    // (nextRunAt) has expired we know no worker is actively processing
    // the task, so we can safely move it to its terminal state.
    // Uses NOW() for clock-skew-safe comparison.
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "BackgroundTask"
      SET "status" = 'canceled',
          "attempts" = 0,
          "lastError" = NULL,
          "completedAt" = NOW(),
          "nextRunAt" = NOW(),
          "isRecurring" = false,
          "scheduleCron" = NULL,
          "scheduleIntervalSeconds" = NULL
      WHERE "userId" = ${actorUserId}
        AND "status" = 'in_progress'
        AND "lifecycleState" = 'canceled'
        AND "nextRunAt" <= NOW()
    `)

    const staleScheduleGraceMs = getTaskMissedScheduleGraceSeconds() * 1000
    const realignedFutureSchedule = await realignFutureRecurringRun({
      userId: actorUserId,
      now,
      graceMs: staleScheduleGraceMs,
    })
    let skippedStaleSchedules = 0
    let candidate: Awaited<ReturnType<typeof prisma.backgroundTask.findFirst>> = null

    for (let index = 0; index < MAX_STALE_SCHEDULE_SKIPS_PER_CALL; index++) {
      const nextCandidate = await prisma.backgroundTask.findFirst({
        where: {
          userId: actorUserId,
          lifecycleState: "active",
          type: {
            in: typeFilter,
          },
          status: {
            in: ["pending", "in_progress"],
          },
          nextRunAt: {
            lte: now,
          },
        },
        orderBy: {
          createdAt: "asc",
        },
      })

      if (!nextCandidate) {
        break
      }

      const scheduled = resolveTaskSchedule(nextCandidate)
      if (nextCandidate.status === "pending" && nextCandidate.isRecurring && !scheduled.enabled) {
        const disabled = await prisma.backgroundTask.updateMany({
          where: {
            id: nextCandidate.id,
            userId: actorUserId,
            lifecycleState: "active",
            status: "pending",
            isRecurring: true,
            nextRunAt: {
              lte: now,
            },
          },
          data: {
            status: "completed",
            completedAt: now,
            nextRunAt: now,
            isRecurring: false,
            scheduleCron: null,
            scheduleIntervalSeconds: null,
            lastError: null,
            executionHistory: addTaskHistoryEntry(
              normalizeExecutionHistory(nextCandidate.executionHistory),
              {
                status: "skipped",
                message: "Disabled scheduled task after cron support was removed",
                metadata: {
                  disabledAt: now.toISOString(),
                },
              }
            ),
          },
        })
        if (disabled.count > 0) {
          skippedStaleSchedules += 1
        }
        continue
      }

      const shouldSkipStaleRun =
        nextCandidate.status === "pending" &&
        scheduled.enabled &&
        now.getTime() - nextCandidate.nextRunAt.getTime() > staleScheduleGraceMs

      if (!shouldSkipStaleRun) {
        candidate = nextCandidate
        break
      }

      const nextRunAt =
        nextRunAtForTaskSchedule(scheduled, now) ??
        new Date(now.getTime() + SYNC_POLL_INTERVAL_SECONDS * 1000)
      const moved = await prisma.backgroundTask.updateMany({
        where: {
          id: nextCandidate.id,
          userId: actorUserId,
          lifecycleState: "active",
          status: "pending",
          nextRunAt: {
            lte: now,
          },
        },
        data: {
          nextRunAt,
          lastError: null,
          executionHistory: addTaskHistoryEntry(
            normalizeExecutionHistory(nextCandidate.executionHistory),
            {
              status: "skipped",
              message: "Skipped stale scheduled run after downtime",
              metadata: {
                previousNextRunAt: nextCandidate.nextRunAt.toISOString(),
                nextRunAt: nextRunAt.toISOString(),
                skippedAt: now.toISOString(),
              },
            }
          ),
        },
      })
      if (moved.count > 0) {
        skippedStaleSchedules += 1
      }
    }

    if (!candidate) {
      if (skippedStaleSchedules > 0) {
        return NextResponse.json({
          processed: false,
          message: "Skipped stale scheduled runs",
          skippedStaleSchedules,
        })
      }
      if (realignedFutureSchedule) {
        return NextResponse.json({
          processed: false,
          message: "Realigned future scheduled run to server time",
        })
      }
      return NextResponse.json({ processed: false, message: "No pending tasks" })
    }

    // Atomically claim the candidate using FOR UPDATE SKIP LOCKED to
    // prevent two workers from claiming the same task, and NOW() for
    // clock-skew-safe timestamp comparisons.
    const lockSeconds = LOCK_SECONDS
    const claimedRows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH locked AS (
        SELECT "id" FROM "BackgroundTask"
        WHERE "id" = ${candidate.id}
          AND "userId" = ${actorUserId}
          AND "lifecycleState" = 'active'
          AND "status" IN ('pending', 'in_progress')
          AND "nextRunAt" <= NOW()
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "BackgroundTask" bt
      SET "status" = 'in_progress',
          "startedAt" = COALESCE(bt."startedAt", NOW()),
          "runCount" = bt."runCount" + 1,
          "lastRunAt" = NOW(),
          "nextRunAt" = NOW() + make_interval(secs => ${lockSeconds})
      FROM locked
      WHERE bt."id" = locked."id"
      RETURNING bt."id"
    `)

    if (claimedRows.length === 0) {
      return NextResponse.json({ processed: false, message: "Task is already being processed" })
    }
    claimedTask = {
      id: candidate.id,
      type: candidate.type,
      runCount: candidate.runCount + 1,
      attempts: candidate.attempts,
      maxAttempts: candidate.maxAttempts,
    }
    claimedTaskSchedule = resolveTaskSchedule(candidate)
    taskExecutionHistory = normalizeExecutionHistory(candidate.executionHistory)

    if (candidate.type === "object_transfer") {
      transferPayload = parseObjectTransferPayload(
        resolveTaskPlanPayload(candidate.executionPlan, candidate.payload)
      )
      return processObjectTransferTask({
        candidate,
        actorUserId,
        claimedTaskSchedule,
        taskExecutionHistory,
      })
    }

    return processBulkDeleteTask({
      candidate,
      actorUserId,
      claimedTaskSchedule,
      taskExecutionHistory,
    })
  } catch (error) {
    console.error("Failed to process task:", error)

    const message = formatTaskProcessingError(error)
    const taskAttemptFailed = Boolean(userId && claimedTask)

    try {
      if (userId && claimedTask) {
        const now = new Date()
        const nextAttempts = claimedTask.attempts + 1
        const retryable = nextAttempts < claimedTask.maxAttempts
        const backoffSeconds = Math.min(300, Math.pow(2, nextAttempts))
        const nextScheduledRunAt =
          claimedTaskSchedule?.enabled
            ? nextRunAtForTaskSchedule(claimedTaskSchedule, now) ??
              new Date(now.getTime() + SYNC_POLL_INTERVAL_SECONDS * 1000)
            : null

        if (claimedTask.type === "object_transfer" && transferPayload) {
          await logUserAuditAction({
            userId,
            eventType: "s3_action",
            eventName: "object_transfer_failed",
            path: "/api/tasks/process",
            method: "POST",
            target: `${transferPayload.sourceBucket} -> ${transferPayload.destinationBucket}`,
            metadata: {
              scope: transferPayload.scope,
              operation: transferPayload.operation,
              sourceCredentialId: transferPayload.sourceCredentialId,
              sourceBucket: transferPayload.sourceBucket,
              sourcePrefix: transferPayload.sourcePrefix,
              destinationCredentialId: transferPayload.destinationCredentialId,
              destinationBucket: transferPayload.destinationBucket,
              destinationPrefix: transferPayload.destinationPrefix,
              error: message,
            },
          })
        }

        const failureUpdate: Prisma.BackgroundTaskUpdateManyMutationInput = (() => {
          if (claimedTaskSchedule?.enabled && !retryable) {
            return {
              attempts: 0,
              status: "pending",
              nextRunAt: nextScheduledRunAt ?? new Date(now.getTime() + backoffSeconds * 1000),
              lastError: message,
              completedAt: null,
              executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
                status: "failed",
                message: "Scheduled run failed",
                metadata: {
                  error: message,
                  nextRunAt: nextScheduledRunAt?.toISOString() ?? null,
                },
              }),
            }
          }

          const base: Prisma.BackgroundTaskUpdateManyMutationInput = {
            attempts: nextAttempts,
            status: retryable ? "pending" : "failed",
            nextRunAt: retryable
              ? new Date(now.getTime() + backoffSeconds * 1000)
              : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
            lastError: message,
            completedAt: retryable ? null : now,
          }
          if (!retryable) {
            base.executionHistory = addTaskHistoryEntry(taskExecutionHistory, {
              status: "failed",
              message,
            })
          }
          return base
        })()

        await persistClaimedTaskCheckpoint({
          taskId: claimedTask.id,
          userId,
          claimedRunCount: claimedTask.runCount,
          normalUpdate: failureUpdate,
        })
      }
    } catch (updateError) {
      console.error("Failed to update task failure state:", updateError)
    }

    // A task-level failure was already persisted (retry scheduled or failed state set).
    // Return 200 to avoid noisy client-side 500s while the queue keeps progressing.
    if (taskAttemptFailed && claimedTask) {
      const nextAttempts = claimedTask.attempts + 1
      const retryable = nextAttempts < claimedTask.maxAttempts
      const scheduledRetry = Boolean(claimedTaskSchedule?.enabled && !retryable)
      const currentTask = await prisma.backgroundTask.findFirst({
        where: {
          id: claimedTask.id,
          userId: userId!,
        },
        select: {
          status: true,
          attempts: true,
          lastError: true,
        },
      })
      return buildProcessedResponse(
        {
          taskId: claimedTask.id,
          taskType: claimedTask.type,
          taskStatus: currentTask?.status ?? (retryable || scheduledRetry ? "pending" : "failed"),
          runCount: claimedTask.runCount,
          attempts: Math.max(0, currentTask?.attempts ?? (scheduledRetry ? 0 : nextAttempts)),
          lastError:
            typeof currentTask?.lastError === "string"
              ? currentTask.lastError
              : currentTask?.lastError === null
                ? null
                : message,
          taskUserId: userId!,
        },
        {
          done: currentTask?.status === "canceled",
          error: message,
          retryable,
        }
      )
    }

    return NextResponse.json({ processed: false, error: message }, { status: 500 })
  }
}
