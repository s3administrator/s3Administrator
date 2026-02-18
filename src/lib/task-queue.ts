import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db"
import { deleteExpiredTaskEvents } from "@/lib/task-run-history"
import {
  getTaskEventRetentionDays,
  getTaskWorkerConcurrency,
  getTaskWorkerScanIntervalSeconds,
  getTaskWorkerUserBudgetMs,
  getTaskWorkerUserBurst,
  type TaskTypeName,
} from "@/lib/task-engine-config"

type BossJob<T = unknown> = {
  data?: T
}

type BossLike = {
  start: () => Promise<void>
  stop: () => Promise<void>
  createQueue: (name: string) => Promise<void>
  schedule: (name: string, cron: string, data?: unknown, options?: Record<string, unknown>) => Promise<unknown>
  send: (name: string, data?: unknown, options?: Record<string, unknown>) => Promise<unknown>
  work: (
    name: string,
    options: Record<string, unknown>,
    handler: (job: BossJob) => Promise<void>
  ) => Promise<unknown>
}

type BossConstructor = new (options: { connectionString: string; schema?: string }) => BossLike

export const TASK_DISPATCH_SCAN_QUEUE = "task-dispatch-scan"
export const TASK_USER_DISPATCH_QUEUE = "task-user-dispatch"
export const TASK_MAINTENANCE_QUEUE = "task-maintenance"

export interface ProcessUserResult {
  processed: boolean
  taskId?: string
}

export interface TaskQueueWorkerOptions {
  workerId: string
  processUserOnce: (userId: string, type?: string) => Promise<ProcessUserResult>
  enabled: boolean
}

const TASK_TYPES = ["bulk_delete", "object_transfer", "thumbnail_generate"] as const

interface DueUserType {
  userId: string
  type: string
}

function extractUserIdFromJobData(data: unknown): string | null {
  const parseStructured = (value: unknown): unknown => {
    if (typeof value === "string") {
      try {
        return JSON.parse(value)
      } catch {
        return null
      }
    }
    if (value && typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      try {
        return JSON.parse(value.toString("utf8"))
      } catch {
        return null
      }
    }
    return value
  }

  const readUserId = (value: unknown): string | null => {
    const payload = parseStructured(value)
    if (!payload || typeof payload !== "object") {
      return null
    }

    const directUserId = (payload as { userId?: unknown }).userId
    if (typeof directUserId === "string" && directUserId.trim()) {
      return directUserId.trim()
    }

    if ("data" in payload) {
      return readUserId((payload as { data?: unknown }).data)
    }

    return null
  }

  return readUserId(data)
}

function createCronEveryNSeconds(seconds: number): string {
  const clamped = Math.min(59, Math.max(2, Math.floor(seconds)))
  return `*/${clamped} * * * * *`
}

async function loadPgBossConstructor(): Promise<BossConstructor | null> {
  try {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<unknown>
    const importedModule = await dynamicImport("pg-boss") as {
      default?: BossConstructor
    }
    return importedModule.default ?? null
  } catch {
    return null
  }
}

async function findDueUserTypes(limit: number): Promise<DueUserType[]> {
  return prisma.$queryRaw<DueUserType[]>(Prisma.sql`
    SELECT DISTINCT t."userId" AS "userId", t."type"
    FROM "BackgroundTask" t
    WHERE t."lifecycleState" = 'active'
      AND t."status" IN ('pending', 'in_progress')
      AND t."type" IN ('bulk_delete', 'thumbnail_generate', 'object_transfer')
      AND t."nextRunAt" <= NOW()
    ORDER BY t."userId"
    LIMIT ${limit}
  `)
}

async function processUserTypeBurst(
  userId: string,
  type: string,
  processUserOnce: (userId: string, type?: string) => Promise<ProcessUserResult>
): Promise<number> {
  const taskType = type as TaskTypeName | undefined
  const budgetMs = getTaskWorkerUserBudgetMs(taskType)
  const maxBurst = getTaskWorkerUserBurst(taskType)
  const startedAt = Date.now()
  let processed = 0

  for (let i = 0; i < maxBurst; i++) {
    if (Date.now() - startedAt >= budgetMs) {
      break
    }

    const result = await processUserOnce(userId, type)
    if (!result.processed) {
      break
    }
    processed += 1
  }

  return processed
}

async function runMaintenance(workerId: string): Promise<void> {
  const deleted = await deleteExpiredTaskEvents(getTaskEventRetentionDays())
  if (deleted > 0) {
    console.info(`[task-worker:${workerId}] pruned ${deleted} expired task events`)
  }
}

async function runFallbackPollingWorker(options: TaskQueueWorkerOptions) {
  const scanIntervalMs = getTaskWorkerScanIntervalSeconds() * 1000

  let stopped = false
  let nextMaintenanceAt = Date.now() + 24 * 60 * 60 * 1000

  const tick = async () => {
    if (stopped) return

    try {
      if (Date.now() >= nextMaintenanceAt) {
        nextMaintenanceAt = Date.now() + 24 * 60 * 60 * 1000
        await runMaintenance(options.workerId)
      }

      const dueRows = await findDueUserTypes(64)
      if (dueRows.length === 0) return

      // Group by user -> set of types with due work
      const userTypes = new Map<string, Set<string>>()
      for (const row of dueRows) {
        const existing = userTypes.get(row.userId)
        if (existing) {
          existing.add(row.type)
        } else {
          userTypes.set(row.userId, new Set([row.type]))
        }
      }

      for (const [userId, types] of userTypes) {
        if (stopped) break
        // Fair round-robin: give each type one burst at a time, rotating until
        // all types are drained. This ensures no single type can starve another.
        const activeTypes = new Set(TASK_TYPES.filter((t) => types.has(t)))

        while (activeTypes.size > 0 && !stopped) {
          for (const type of TASK_TYPES) {
            if (!activeTypes.has(type)) continue
            try {
              const processed = await processUserTypeBurst(userId, type, options.processUserOnce)
              if (processed === 0) {
                activeTypes.delete(type)
              }
            } catch (error) {
              console.error(`[task-worker:${options.workerId}] user type burst failed`, {
                userId,
                type,
                error,
              })
              activeTypes.delete(type)
            }
          }
        }
      }
    } catch (error) {
      console.error(`[task-worker:${options.workerId}] fallback scan failed`, error)
    }
  }

  const interval = setInterval(() => {
    void tick()
  }, scanIntervalMs)
  // Keep the process alive in fallback mode; otherwise Docker restart loops.
  await tick()

  return async () => {
    stopped = true
    clearInterval(interval)
  }
}

async function runPgBossWorker(
  options: TaskQueueWorkerOptions,
  Boss: BossConstructor
) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for task queue worker")
  }

  const boss = new Boss({
    connectionString: databaseUrl,
    schema: "public",
  })
  await boss.start()
  await boss.createQueue(TASK_DISPATCH_SCAN_QUEUE)
  await boss.createQueue(TASK_USER_DISPATCH_QUEUE)
  await boss.createQueue(TASK_MAINTENANCE_QUEUE)

  const cron = createCronEveryNSeconds(getTaskWorkerScanIntervalSeconds())
  await boss.schedule(
    TASK_DISPATCH_SCAN_QUEUE,
    cron,
    {},
    { singletonKey: "global-dispatch-scan" }
  )
  await boss.schedule(
    TASK_MAINTENANCE_QUEUE,
    "0 0 3 * * *",
    {},
    { singletonKey: "task-maintenance-daily" }
  )

  await boss.work(TASK_DISPATCH_SCAN_QUEUE, { teamSize: 1 }, async () => {
    const dueRows = await findDueUserTypes(Math.max(64, getTaskWorkerConcurrency() * 8))
    const slotByUserType = new Map<string, number>()
    for (const { userId, type } of dueRows) {
      const key = `${userId}:${type}`
      const slotIndex = slotByUserType.get(key) ?? 0
      slotByUserType.set(key, slotIndex + 1)
      await boss.send(
        TASK_USER_DISPATCH_QUEUE,
        { userId, type, slotIndex },
        {
          singletonKey: `user:${userId}:type:${type}:slot:${slotIndex}`,
          singletonSeconds: 30,
          retryLimit: 0,
        }
      )
    }
  })

  await boss.work(
    TASK_USER_DISPATCH_QUEUE,
    {
      teamSize: getTaskWorkerConcurrency(),
      retryLimit: 0,
    },
    async (job) => {
      const jobs = Array.isArray(job) ? job : [job]
      for (const current of jobs) {
        const rawData =
          current && typeof current === "object" && "data" in current
            ? (current as { data?: unknown }).data
            : current
        const userId = extractUserIdFromJobData(rawData)
        if (!userId) {
          console.warn(`[task-worker:${options.workerId}] skipped dispatch job with invalid payload`)
          continue
        }
        const type = rawData && typeof rawData === "object" && "type" in rawData
          ? String((rawData as { type?: unknown }).type)
          : undefined
        await processUserTypeBurst(userId, type ?? "bulk_delete", options.processUserOnce)
      }
    }
  )

  await boss.work(TASK_MAINTENANCE_QUEUE, { teamSize: 1 }, async () => {
    await runMaintenance(options.workerId)
  })

  return async () => {
    await boss.stop()
  }
}

export async function startTaskQueueWorker(options: TaskQueueWorkerOptions) {
  if (!options.enabled) {
    return async () => {}
  }

  const Boss = await loadPgBossConstructor()
  if (!Boss) {
    console.warn("[task-worker] pg-boss unavailable; using fallback DB polling scheduler")
    return runFallbackPollingWorker(options)
  }

  try {
    return await runPgBossWorker(options, Boss)
  } catch (error) {
    console.error("[task-worker] pg-boss scheduler failed, falling back to DB polling", error)
    return runFallbackPollingWorker(options)
  }
}
