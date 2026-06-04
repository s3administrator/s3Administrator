import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { applyUserExtensionStatsDelta, rebuildUserExtensionStats } from "@/lib/file-stats"
import { buildFileSearchSqlWhereClause, parseScopes } from "@/lib/file-search"
import { getTaskBulkDeleteBatchSize } from "@/lib/task-engine-config"
import {
  nextRunAtForTaskSchedule,
  type ResolvedTaskSchedule,
} from "@/lib/task-schedule"
import { type TaskExecutionHistoryEntry } from "@/lib/task-plans"
import {
  SYNC_POLL_INTERVAL_SECONDS,
  parsePayload,
  parseProgress,
  resolveTaskPlanPayload,
  addTaskHistoryEntry,
  buildProcessedResponse,
  snapshotFromCheckpoint,
  persistClaimedTaskCheckpoint,
  failTaskTerminal,
  deleteKeysFromBucket,
} from "@/lib/task-process-shared"

export interface ProcessBulkDeleteParams {
  candidate: {
    id: string
    type: string
    runCount: number
    attempts: number
    maxAttempts: number
    progress: unknown
    executionPlan: unknown
    payload: unknown
    lastError: string | null
    startedAt: Date | null
    isRecurring: boolean
  }
  actorUserId: string
  claimedTaskSchedule: ResolvedTaskSchedule | null
  taskExecutionHistory: TaskExecutionHistoryEntry[]
}

export async function processBulkDeleteTask(
  params: ProcessBulkDeleteParams
): Promise<NextResponse> {
  const { candidate, actorUserId, claimedTaskSchedule, taskExecutionHistory } = params

  const bulkPlanPayload = resolveTaskPlanPayload(candidate.executionPlan, candidate.payload)
  const payload = parsePayload(bulkPlanPayload)
  if (!payload) {
    return failTaskTerminal({
      candidate, actorUserId, taskExecutionHistory,
      errorMessage: "Invalid task payload",
    })
  }

  const whereClause = buildFileSearchSqlWhereClause({
    userId: actorUserId,
    query: payload.query,
    credentialIds: payload.selectedCredentialIds,
    scopes: parseScopes(payload.selectedBucketScopes),
    type: payload.selectedType,
  })
  const progress = parseProgress(candidate.progress)
  const bulkDeleteTotal =
    progress.total > 0
      ? progress.total
      : progress.deleted + Number((
          await prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
            SELECT COUNT(*)::bigint AS "total"
            FROM "FileMetadata" fm
            WHERE ${whereClause}
            ${progress.cursorId ? Prisma.sql`AND fm."id" > ${progress.cursorId}` : Prisma.empty}
          `)
        )[0]?.total ?? BigInt(0))

  const batch = await prisma.$queryRaw<Array<{
    id: string
    key: string
    bucket: string
    credentialId: string
    extension: string
    size: bigint
  }>>(Prisma.sql`
    SELECT
      fm."id",
      fm."key",
      fm."bucket",
      fm."credentialId",
      fm."extension",
      fm."size"
    FROM "FileMetadata" fm
    WHERE ${whereClause}
    ${progress.cursorId ? Prisma.sql`AND fm."id" > ${progress.cursorId}` : Prisma.empty}
    ORDER BY fm."id" ASC
    LIMIT ${getTaskBulkDeleteBatchSize()}
  `)

  if (batch.length === 0) {
    if (claimedTaskSchedule?.enabled) {
      const nextRunAt =
        nextRunAtForTaskSchedule(claimedTaskSchedule, new Date()) ??
        new Date(Date.now() + SYNC_POLL_INTERVAL_SECONDS * 1000)
      const scheduledEmptyCheckpoint = await persistClaimedTaskCheckpoint({
        taskId: candidate.id,
        userId: actorUserId,
        claimedRunCount: candidate.runCount + 1,
        normalUpdate: {
          status: "pending",
          attempts: 0,
          completedAt: null,
          nextRunAt,
          progress: {
            total: 0,
            deleted: 0,
            remaining: 0,
            cursorId: null,
          },
          lastError: null,
          executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
            status: "succeeded",
            message: "Scheduled bulk delete cycle completed",
            metadata: {
              deleted: bulkDeleteTotal,
              nextRunAt: nextRunAt.toISOString(),
              schedule: claimedTaskSchedule.cron ?? claimedTaskSchedule.legacyIntervalSeconds,
            },
          }),
        },
      })

      return buildProcessedResponse(
        snapshotFromCheckpoint(candidate, actorUserId, scheduledEmptyCheckpoint),
        {
          done: scheduledEmptyCheckpoint.appliedMode === "canceled",
          recurring: scheduledEmptyCheckpoint.appliedMode === "normal",
          nextRunAt:
            scheduledEmptyCheckpoint.appliedMode === "normal"
              ? nextRunAt.toISOString()
              : undefined,
        }
      )
    }

    const emptyCompletionCheckpoint = await persistClaimedTaskCheckpoint({
      taskId: candidate.id,
      userId: actorUserId,
      claimedRunCount: candidate.runCount + 1,
      preferTerminal: true,
      normalUpdate: {
        status: "completed",
        lifecycleState: "active",
        attempts: 0,
        completedAt: new Date(),
        nextRunAt: new Date(),
        progress: {
          total: bulkDeleteTotal,
          deleted: bulkDeleteTotal,
          remaining: 0,
          cursorId: null,
        },
        lastError: null,
        executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
          status: "succeeded",
          message: "Bulk delete completed",
          metadata: {
            deleted: bulkDeleteTotal,
          },
        }),
      },
    })

    return buildProcessedResponse(
      snapshotFromCheckpoint(candidate, actorUserId, emptyCompletionCheckpoint),
      { done: true }
    )
  }

  const grouped = new Map<string, { bucket: string; credentialId: string; rows: typeof batch }>()

  for (const row of batch) {
    const groupKey = `${row.credentialId}::${row.bucket}`
    const existing = grouped.get(groupKey)
    if (existing) {
      existing.rows.push(row)
    } else {
      grouped.set(groupKey, {
        bucket: row.bucket,
        credentialId: row.credentialId,
        rows: [row],
      })
    }
  }

  const clients = new Map<string, InstanceType<typeof import("@aws-sdk/client-s3").S3Client>>()
  const deletedIds = new Set<string>()

  for (const group of grouped.values()) {
    let client = clients.get(group.credentialId)
    if (!client) {
      const response = await getS3Client(actorUserId, group.credentialId, {
        trafficClass: "background",
      })
      client = response.client
      clients.set(group.credentialId, client)
    }

    const keys = group.rows.map((row) => row.key)
    const deletedKeys = await deleteKeysFromBucket(client, group.bucket, keys)

    for (const row of group.rows) {
      if (deletedKeys.has(row.key)) {
        deletedIds.add(row.id)
      }
    }
  }

  if (deletedIds.size === 0) {
    throw new Error("No files could be deleted in this batch")
  }

  await prisma.fileMetadata.deleteMany({
    where: {
      id: {
        in: Array.from(deletedIds),
      },
    },
  })

  const deletedRows = batch.filter((row) => deletedIds.has(row.id))
  try {
    await applyUserExtensionStatsDelta(
      actorUserId,
      deletedRows.map((row) => ({
        extension: row.extension,
        size: row.size,
      }))
    )
  } catch {
    await rebuildUserExtensionStats(actorUserId)
  }

  const total = bulkDeleteTotal
  const deleted = Math.min(total, progress.deleted + deletedIds.size)
  const remaining = Math.max(0, total - deleted)
  let lastBatchCursorId = progress.cursorId
  let cursorBlocked = false
  for (const row of batch) {
    if (!cursorBlocked && deletedIds.has(row.id)) {
      lastBatchCursorId = row.id
    } else {
      cursorBlocked = true
    }
  }

  if (remaining === 0 && claimedTaskSchedule?.enabled) {
    const nextRunAt =
      nextRunAtForTaskSchedule(claimedTaskSchedule, new Date()) ??
      new Date(Date.now() + SYNC_POLL_INTERVAL_SECONDS * 1000)
    const scheduledRemainingCheckpoint = await persistClaimedTaskCheckpoint({
      taskId: candidate.id,
      userId: actorUserId,
      claimedRunCount: candidate.runCount + 1,
      normalUpdate: {
        status: "pending",
        attempts: 0,
        completedAt: null,
        nextRunAt,
        progress: {
          total: 0,
          deleted: 0,
          remaining: 0,
          cursorId: null,
        },
        lastError: null,
        executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
          status: "succeeded",
          message: "Scheduled bulk delete cycle completed",
          metadata: {
            total,
            deleted,
            nextRunAt: nextRunAt.toISOString(),
            schedule: claimedTaskSchedule.cron ?? claimedTaskSchedule.legacyIntervalSeconds,
          },
        }),
      },
    })

    return buildProcessedResponse(
      snapshotFromCheckpoint(candidate, actorUserId, scheduledRemainingCheckpoint),
      {
        deletedInBatch: deletedIds.size,
        done: scheduledRemainingCheckpoint.appliedMode === "canceled",
        recurring: scheduledRemainingCheckpoint.appliedMode === "normal",
        nextRunAt:
          scheduledRemainingCheckpoint.appliedMode === "normal"
            ? nextRunAt.toISOString()
            : undefined,
      }
    )
  }

  const bulkCheckpoint = await persistClaimedTaskCheckpoint({
    taskId: candidate.id,
    userId: actorUserId,
    claimedRunCount: candidate.runCount + 1,
    preferTerminal: remaining === 0,
    normalUpdate: {
      status: remaining === 0 ? "completed" : "in_progress",
      lifecycleState: remaining === 0 ? "active" : undefined,
      attempts: 0,
      completedAt: remaining === 0 ? new Date() : null,
      nextRunAt: new Date(),
      progress: {
        total,
        deleted,
        remaining,
        cursorId: remaining === 0 ? null : lastBatchCursorId,
      },
      lastError: null,
      ...(remaining === 0
        ? {
            executionHistory: addTaskHistoryEntry(taskExecutionHistory, {
              status: "succeeded",
              message: "Bulk delete completed",
              metadata: {
                total,
                deleted,
              },
            }),
          }
        : {}),
    },
  })

  return buildProcessedResponse(
    snapshotFromCheckpoint(candidate, actorUserId, bulkCheckpoint),
    {
      deletedInBatch: deletedIds.size,
      done: remaining === 0 || bulkCheckpoint.appliedMode === "canceled",
    }
  )
}
