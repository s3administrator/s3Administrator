import { hostname } from "node:os"
import { prisma } from "@/lib/db"
import {
  getTaskEngineInternalToken,
  getTaskWorkerAppUrl,
  isTaskEngineV2Enabled,
} from "@/lib/task-engine-config"
import { recordTaskRunFromSnapshot } from "@/lib/task-run-history"
import { startTaskQueueWorker } from "@/lib/task-queue"

interface ProcessRouteResponse {
  processed?: boolean
  taskId?: string
  taskType?: string
  taskStatus?: string
  runCount?: number
  attempts?: number
  lastError?: string | null
  taskUserId?: string
  done?: boolean
}

function buildWorkerId(): string {
  const host = hostname()
  return `${host}:${process.pid}`
}

async function processUserOnce(userId: string, workerId: string, type?: string) {
  const token = getTaskEngineInternalToken()
  if (!token) {
    throw new Error("TASK_ENGINE_INTERNAL_TOKEN must be configured for worker processing")
  }

  const baseUrl = getTaskWorkerAppUrl().replace(/\/+$/, "")
  const typeParam = type ? `&type=${encodeURIComponent(type)}` : ""
  const url = `${baseUrl}/api/tasks/process?userId=${encodeURIComponent(userId)}${typeParam}`

  const startedAt = new Date()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000)

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-task-engine-token": token,
      },
      redirect: "manual",
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
  const finishedAt = new Date()

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location")
    throw new Error(
      `Task process request redirected for user ${userId} (${response.status})${location ? ` -> ${location}` : ""}`
    )
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(
      `Task process request failed for user ${userId} (${response.status}): ${body || response.statusText}`
    )
  }

  const payload = (await response.json()) as ProcessRouteResponse
  if (
    !payload.processed ||
    !payload.taskId ||
    !payload.taskType ||
    !payload.taskStatus ||
    !payload.taskUserId ||
    typeof payload.runCount !== "number" ||
    typeof payload.attempts !== "number"
  ) {
    return { processed: false }
  }

  await recordTaskRunFromSnapshot({
    snapshot: {
      id: payload.taskId,
      userId: payload.taskUserId,
      type: payload.taskType,
      runCount: Math.max(1, Math.floor(payload.runCount)),
      attempts: Math.max(0, Math.floor(payload.attempts)),
      status: payload.taskStatus,
      lastError: typeof payload.lastError === "string" ? payload.lastError : null,
    },
    startedAt,
    finishedAt,
    workerId,
    metrics: {
      done: Boolean(payload.done),
    },
  })

  return {
    processed: true,
    taskId: payload.taskId,
  }
}

async function main() {
  if (!isTaskEngineV2Enabled()) {
    console.info("[task-worker] TASK_ENGINE_V2 is disabled. Worker idle.")
    return
  }

  const workerId = buildWorkerId()
  const stop = await startTaskQueueWorker({
    workerId,
    enabled: true,
    processUserOnce: (userId, type) => processUserOnce(userId, workerId, type),
  })

  console.info(`[task-worker] started (${workerId})`)

  const shutdown = async (signal: string) => {
    console.info(`[task-worker] shutting down on ${signal}`)
    await stop()
    await prisma.$disconnect().catch(() => {})
    process.exit(0)
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT")
  })
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM")
  })
}

void main().catch(async (error) => {
  console.error("[task-worker] fatal error", error)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
