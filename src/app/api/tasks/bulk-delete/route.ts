import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import {
  buildFileSearchSqlWhereClause,
  parseScopes,
} from "@/lib/file-search"
import { buildTaskDedupeKey, createTaskExecutionPlan } from "@/lib/task-plans"
import { kickTaskProcessing } from "@/lib/task-notify"
import { TASK_SCHEDULES_DISABLED_MESSAGE } from "@/lib/task-schedule"
import { isBackgroundTaskSchemaOutdated, backgroundTaskSchemaOutdatedResponse } from "@/lib/task-errors"

interface BulkDeletePayload {
  query: string
  selectedType?: string
  selectedCredentialIds?: string[]
  selectedBucketScopes?: string[]
  schedule?: {
    cron?: string
  } | null
  confirmDestructiveSchedule?: boolean
}

interface CountRow {
  total: bigint
}

interface BulkDeleteTaskPreview {
  type: "bulk_delete"
  summary: string[]
  commands: string[]
  estimatedObjects: number
  sampleObjects: string[]
  warnings: string[]
}

function buildBulkDeletePreview(params: {
  query: string
  selectedType: string
  selectedCredentialIds: string[]
  selectedBucketScopes: string[]
  total: number
  sampleObjects: string[]
  duplicateQueued: boolean
  scheduleCron: string | null
}): BulkDeleteTaskPreview {
  const summary = [
    `Search query: "${params.query}"`,
    `File type filter: ${params.selectedType}`,
    params.selectedCredentialIds.length > 0
      ? `Accounts in scope: ${params.selectedCredentialIds.length}`
      : "Accounts in scope: all",
    params.selectedBucketScopes.length > 0
      ? `Bucket scopes in scope: ${params.selectedBucketScopes.length}`
      : "Bucket scopes in scope: all",
    `Estimated matching indexed objects: ${params.total.toLocaleString()}`,
    params.scheduleCron
      ? `Schedule: CRON (${params.scheduleCron}) UTC`
      : "Schedule: one-time run",
  ]

  const commands = [
    "Resolve matching object keys from local metadata index in chunks.",
    "Delete matched objects from object storage in batches of up to 1000 keys.",
    "Delete matched metadata rows and thumbnail records.",
    "Persist task progress checkpoint after each batch.",
  ]

  const warnings = [
    "Bulk delete permanently removes matched objects from object storage.",
  ]
  if (params.duplicateQueued) {
    warnings.push("An equivalent bulk delete task is already queued or running.")
  }
  if (params.scheduleCron) {
    warnings.push("Recurring destructive task is enabled. Each run can delete objects.")
  }

  return {
    type: "bulk_delete",
    summary,
    commands,
    estimatedObjects: params.total,
    sampleObjects: params.sampleObjects,
    warnings,
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = (await request.json()) as BulkDeletePayload & { previewOnly?: unknown }
    const previewOnly =
      typeof body?.previewOnly === "boolean" ? Boolean(body.previewOnly) : false
    const query = typeof body?.query === "string" ? body.query.trim() : ""
    const selectedType = typeof body?.selectedType === "string" ? body.selectedType : "all"
    const selectedCredentialIds = Array.isArray(body?.selectedCredentialIds)
      ? body.selectedCredentialIds.filter((value): value is string => typeof value === "string")
      : []
    const selectedBucketScopes = Array.isArray(body?.selectedBucketScopes)
      ? body.selectedBucketScopes.filter((value): value is string => typeof value === "string")
      : []
    if (body?.schedule) {
      return NextResponse.json(
        { error: TASK_SCHEDULES_DISABLED_MESSAGE },
        { status: 400 }
      )
    }
    const scheduleCron: string | null = null

    const normalizedCredentialIds = Array.from(new Set(selectedCredentialIds)).sort()
    const normalizedBucketScopes = Array.from(new Set(selectedBucketScopes)).sort()

    if (query.length < 2) {
      return NextResponse.json(
        { error: "query must be at least 2 characters" },
        { status: 400 }
      )
    }

    const whereClause = buildFileSearchSqlWhereClause({
      userId: session.user.id,
      query,
      credentialIds: normalizedCredentialIds,
      scopes: parseScopes(normalizedBucketScopes),
      type: selectedType,
    })
    const [countResult] = await prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "total"
      FROM "FileMetadata" fm
      WHERE ${whereClause}
    `)
    const total = Number(countResult?.total ?? 0)
    const sampleObjects = previewOnly
      ? (
        await prisma.$queryRaw<Array<{ bucket: string; key: string }>>(Prisma.sql`
            SELECT fm."bucket", fm."key"
            FROM "FileMetadata" fm
            WHERE ${whereClause}
            ORDER BY fm."id" ASC
            LIMIT 12
          `)
      ).map((row) => `${row.bucket}/${row.key}`)
      : []

    if (total === 0) {
      return NextResponse.json(
        { error: "No indexed files matched this selection" },
        { status: 400 }
      )
    }

    const taskPayload = {
      query,
      selectedType,
      selectedCredentialIds: normalizedCredentialIds,
      selectedBucketScopes: normalizedBucketScopes,
    }
    const dedupeKey = buildTaskDedupeKey("bulk_delete", {
      payload: taskPayload,
      scheduleCron,
    })

    const existingTask = await prisma.backgroundTask.findFirst({
      where: {
        userId: session.user.id,
        type: "bulk_delete",
        dedupeKey,
        lifecycleState: {
          in: ["active", "paused"],
        },
        status: {
          in: ["pending", "in_progress"],
        },
      },
      select: {
        id: true,
        type: true,
        title: true,
        status: true,
        progress: true,
      },
    })

    if (previewOnly) {
      return NextResponse.json({
        preview: buildBulkDeletePreview({
          query,
          selectedType,
          selectedCredentialIds: normalizedCredentialIds,
          selectedBucketScopes: normalizedBucketScopes,
          total,
          sampleObjects,
          duplicateQueued: Boolean(existingTask),
          scheduleCron,
        }),
        duplicate: Boolean(existingTask),
        task: existingTask ?? null,
      })
    }

    if (existingTask) {
      return NextResponse.json({
        task: existingTask,
        duplicate: true,
      })
    }

    const task = await prisma.backgroundTask.create({
      data: {
        userId: session.user.id,
        type: "bulk_delete",
        title: `Bulk delete: ${query}`,
        status: "pending",
        lifecycleState: "active",
        payload: taskPayload,
        executionPlan: createTaskExecutionPlan("bulk_delete", taskPayload),
        dedupeKey,
        isRecurring: false,
        scheduleCron,
        scheduleIntervalSeconds: null,
        progress: {
          total,
          deleted: 0,
          remaining: total,
          cursorId: null,
        },
      },
      select: {
        id: true,
        type: true,
        title: true,
        status: true,
        progress: true,
      },
    })

    kickTaskProcessing({ userId: session.user.id, type: "bulk_delete" })

    return NextResponse.json({ task })
  } catch (error) {
    console.error("Failed to create bulk delete task:", error)
    if (isBackgroundTaskSchemaOutdated(error)) {
      return backgroundTaskSchemaOutdatedResponse()
    }
    const message = error instanceof Error ? error.message : "Failed to create bulk delete task"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
