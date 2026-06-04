import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db"

export type TaskRunStatus =
  | "in_progress"
  | "succeeded"
  | "failed"
  | "skipped"
  | "retrying"

export interface TaskRunSnapshot {
  id: string
  userId: string
  type: string
  runCount: number
  attempts: number
  status: string
  lastError: string | null
}

export function deriveRunStatus(taskStatus: string, lastError: string | null): TaskRunStatus {
  if (taskStatus === "canceled") return "skipped"
  if (taskStatus === "completed") {
    return lastError ? "failed" : "succeeded"
  }
  if (taskStatus === "failed") return "failed"
  if (taskStatus === "in_progress") return "in_progress"
  if (taskStatus === "pending" && !lastError) return "succeeded"
  if (taskStatus === "pending" && lastError) return "retrying"
  return "in_progress"
}

function isPrismaMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { code?: unknown }
  return candidate.code === "P2021"
}

export async function recordTaskRunFromSnapshot(params: {
  snapshot: TaskRunSnapshot
  startedAt: Date
  finishedAt: Date
  workerId: string
  metrics?: Prisma.InputJsonObject
}) {
  const { snapshot, startedAt, finishedAt, workerId, metrics } = params
  const runNumber = Math.max(1, snapshot.runCount)
  const attempt = Math.max(1, snapshot.attempts || 1)
  const status = deriveRunStatus(snapshot.status, snapshot.lastError)

  try {
    const run = await prisma.backgroundTaskRun.upsert({
      where: {
        taskId_runNumber: {
          taskId: snapshot.id,
          runNumber,
        },
      },
      create: {
        taskId: snapshot.id,
        userId: snapshot.userId,
        runNumber,
        attempt,
        status,
        startedAt,
        finishedAt,
        error: snapshot.lastError,
        metrics: metrics ?? undefined,
        workerId,
      },
      update: {
        attempt,
        status,
        startedAt,
        finishedAt,
        error: snapshot.lastError,
        metrics: metrics ?? undefined,
        workerId,
      },
      select: {
        id: true,
        status: true,
      },
    })

    await prisma.backgroundTaskEvent.create({
      data: {
        taskId: snapshot.id,
        runId: run.id,
        userId: snapshot.userId,
        at: finishedAt,
        eventType: `run_${run.status}`,
        message:
          run.status === "succeeded"
            ? "Task run completed"
            : run.status === "failed"
              ? "Task run failed"
              : run.status === "retrying"
                ? "Task run scheduled for retry"
                : run.status === "skipped"
                  ? "Task run canceled"
                : "Task run updated",
        metadata: {
          workerId,
          taskType: snapshot.type,
          runNumber,
          attempt,
        },
      },
    })
  } catch (error) {
    if (isPrismaMissingTableError(error)) {
      return
    }
    throw error
  }
}

export async function appendTaskEvent(params: {
  taskId: string
  userId: string
  runId?: string | null
  eventType: string
  message: string
  metadata?: Prisma.InputJsonObject
}) {
  try {
    await prisma.backgroundTaskEvent.create({
      data: {
        taskId: params.taskId,
        runId: params.runId ?? null,
        userId: params.userId,
        eventType: params.eventType,
        message: params.message,
        metadata: params.metadata,
      },
    })
  } catch (error) {
    if (isPrismaMissingTableError(error)) {
      return
    }
    throw error
  }
}

export async function deleteExpiredTaskEvents(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  try {
    const deleted = await prisma.backgroundTaskEvent.deleteMany({
      where: {
        at: {
          lt: cutoff,
        },
      },
    })
    return deleted.count
  } catch (error) {
    if (isPrismaMissingTableError(error)) {
      return 0
    }
    throw error
  }
}
