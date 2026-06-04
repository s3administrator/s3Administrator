import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db"
import {
  getTaskWorkerPerUserParallelism,
  getTaskWorkerScanIntervalSeconds,
} from "@/lib/task-engine-config"
import { taskReadyEmitter, TASK_READY_EVENT } from "@/lib/task-notify"
import { executeTaskForUser } from "@/lib/task-executor"

const TASK_TYPES = ["bulk_delete", "object_transfer"] as const

interface DueUserType {
  userId: string
  type: string
}

async function findDueUserTypes(): Promise<DueUserType[]> {
  return prisma.$queryRaw<DueUserType[]>(Prisma.sql`
    SELECT DISTINCT t."userId" AS "userId", t."type"
    FROM "BackgroundTask" t
    WHERE t."lifecycleState" = 'active'
      AND t."status" IN ('pending', 'in_progress')
      AND t."type" IN ('bulk_delete', 'object_transfer')
      AND t."nextRunAt" <= NOW()
    ORDER BY t."userId"
    LIMIT 32
  `)
}

async function processOnce(userId: string, type?: string): Promise<boolean> {
  try {
    const token = process.env.TASK_ENGINE_INTERNAL_TOKEN ?? "embedded-worker"
    const result = await executeTaskForUser(userId, token, type)
    return Boolean(result.processed)
  } catch {
    return false
  }
}

// Process one burst for a given type. Returns true if any work was done.
async function processBurst(userId: string, type: string, concurrency: number): Promise<boolean> {
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => processOnce(userId, type))
  )
  return results.some(Boolean)
}

async function tick() {
  try {
    const dueRows = await findDueUserTypes()
    if (dueRows.length === 0) return

    const concurrency = getTaskWorkerPerUserParallelism()

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
      // Fair round-robin: give each type one burst at a time, rotating until
      // all types are drained. This ensures no single type (e.g. thousands of
      // thumbnail tasks) can starve another (e.g. a single copy task).
      const activeTypes = new Set(TASK_TYPES.filter((t) => types.has(t)))

      while (activeTypes.size > 0) {
        for (const type of TASK_TYPES) {
          if (!activeTypes.has(type)) continue
          const didWork = await processBurst(userId, type, concurrency)
          if (!didWork) {
            activeTypes.delete(type)
          }
        }
      }
    }
  } catch {
    // silently ignore — will retry on next tick
  }
}

let tickInProgress = false
let pendingKick = false

async function safeTick() {
  if (tickInProgress) {
    pendingKick = true
    return
  }
  tickInProgress = true
  try {
    await tick()
  } finally {
    tickInProgress = false
    if (pendingKick) {
      pendingKick = false
      queueMicrotask(() => { void safeTick() })
    }
  }
}

export function startEmbeddedTaskWorker() {
  // Set a default internal token if not configured (local dev convenience)
  if (!process.env.TASK_ENGINE_INTERNAL_TOKEN) {
    process.env.TASK_ENGINE_INTERNAL_TOKEN = "embedded-worker"
  }

  const scanIntervalMs = getTaskWorkerScanIntervalSeconds() * 1000

  // Reduced from 5s — 1s is enough for the Next.js server to start listening
  setTimeout(() => {
    void safeTick()
    setInterval(() => {
      void safeTick()
    }, scanIntervalMs)
  }, 1_000)

  // Instant kick: process tasks immediately when created instead of waiting
  // for the next poll interval
  taskReadyEmitter.on(TASK_READY_EVENT, () => {
    void safeTick()
  })

  console.info(`[embedded-task-worker] started (polls every ${getTaskWorkerScanIntervalSeconds()}s, instant kick enabled)`)
}
