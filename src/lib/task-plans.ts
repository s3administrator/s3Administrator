import { createHash } from "node:crypto"

export type TaskLifecycleState = "active" | "paused" | "canceled"

export type TaskPlanJsonPrimitive = string | number | boolean | null
export type TaskPlanJsonValue = TaskPlanJsonPrimitive | TaskPlanJsonObject | TaskPlanJsonValue[]
export type TaskPlanJsonObject = {
  [key: string]: TaskPlanJsonValue
}

export interface TaskExecutionPlan<TPayload extends TaskPlanJsonValue = TaskPlanJsonValue>
  extends TaskPlanJsonObject {
  version: 1
  type: string
  createdAt: string
  payload: TPayload
}

export interface TaskExecutionHistoryEntry {
  at: string
  status: "succeeded" | "failed" | "skipped" | "paused" | "resumed" | "restarted"
  message: string
  metadata?: Record<string, unknown>
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null"

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    )
    return `{${entries
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
      .join(",")}}`
  }

  return JSON.stringify(value)
}

export function createTaskExecutionPlan<TPayload extends TaskPlanJsonValue>(
  type: string,
  payload: TPayload
): TaskExecutionPlan<TPayload> {
  return {
    version: 1,
    type,
    createdAt: new Date().toISOString(),
    payload,
  }
}

export function buildTaskDedupeKey(type: string, payload: unknown): string {
  return createHash("sha256")
    .update(type)
    .update(":")
    .update(stableStringify(payload))
    .digest("hex")
}

export function getUpcomingRunDates(
  nextRunAt: Date,
  intervalSeconds: number | null | undefined,
  count = 3
): string[] {
  if (!intervalSeconds || intervalSeconds <= 0 || !Number.isFinite(intervalSeconds)) {
    return []
  }

  const result: string[] = []
  const start = nextRunAt.getTime()
  for (let i = 0; i < count; i++) {
    result.push(new Date(start + i * intervalSeconds * 1000).toISOString())
  }
  return result
}

export function normalizeExecutionHistory(
  raw: unknown
): TaskExecutionHistoryEntry[] {
  if (!Array.isArray(raw)) return []

  const result: TaskExecutionHistoryEntry[] = []

  for (const value of raw) {
    if (!value || typeof value !== "object") continue
    const candidate = value as {
      at?: unknown
      status?: unknown
      message?: unknown
      metadata?: unknown
    }

    if (typeof candidate.at !== "string" || !candidate.at.trim()) continue
    if (
      candidate.status !== "succeeded" &&
      candidate.status !== "failed" &&
      candidate.status !== "skipped" &&
      candidate.status !== "paused" &&
      candidate.status !== "resumed" &&
      candidate.status !== "restarted"
    ) {
      continue
    }
    if (typeof candidate.message !== "string" || !candidate.message.trim()) continue

    result.push({
      at: candidate.at,
      status: candidate.status,
      message: candidate.message,
      metadata:
        candidate.metadata && typeof candidate.metadata === "object"
          ? (candidate.metadata as Record<string, unknown>)
          : undefined,
    })
  }

  return result
}

export function appendExecutionHistory(
  current: unknown,
  entry: TaskExecutionHistoryEntry,
  limit = 50
): TaskExecutionHistoryEntry[] {
  const history = normalizeExecutionHistory(current)
  const next = [entry, ...history]
  return next.slice(0, Math.max(1, limit))
}
