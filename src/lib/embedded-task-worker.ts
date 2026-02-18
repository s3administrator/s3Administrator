import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db"
import { getTaskMaxActivePerUser, getTaskWorkerScanIntervalSeconds, type TaskTypeName } from "@/lib/task-engine-config"
const PORT = process.env.PORT || "3000"

const TASK_TYPES = ["bulk_delete", "object_transfer", "thumbnail_generate"] as const

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
      AND t."type" IN ('bulk_delete', 'thumbnail_generate', 'object_transfer')
      AND t."nextRunAt" <= NOW()
    ORDER BY t."userId"
    LIMIT 32
  `)
}

async function processOnce(userId: string, type?: string): Promise<boolean> {
  try {
    const typeParam = type ? `&type=${encodeURIComponent(type)}` : ""
    const res = await fetch(`http://localhost:${PORT}/api/tasks/process?userId=${encodeURIComponent(userId)}${typeParam}`, {
      method: "POST",
      headers: {
        "x-task-engine-token": process.env.TASK_ENGINE_INTERNAL_TOKEN ?? "embedded-worker",
      },
    })
    if (!res.ok) return false
    const body = (await res.json()) as { processed?: boolean }
    return Boolean(body.processed)
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
          const concurrency = getTaskMaxActivePerUser(type as TaskTypeName)
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

export function startEmbeddedTaskWorker() {
  // Set a default internal token if not configured (local dev convenience)
  if (!process.env.TASK_ENGINE_INTERNAL_TOKEN) {
    process.env.TASK_ENGINE_INTERNAL_TOKEN = "embedded-worker"
  }

  const scanIntervalMs = getTaskWorkerScanIntervalSeconds() * 1000

  // Delay the first tick to let the Next.js server start up
  setTimeout(() => {
    void tick()
    setInterval(() => {
      void tick()
    }, scanIntervalMs)
  }, 5_000)

  console.info(`[embedded-task-worker] started (polls every ${getTaskWorkerScanIntervalSeconds()}s)`)
}
