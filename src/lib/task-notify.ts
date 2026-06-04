import { EventEmitter } from "node:events"

export const taskReadyEmitter = new EventEmitter()
taskReadyEmitter.setMaxListeners(10)

export const TASK_READY_EVENT = "task-ready"

export interface TaskReadyPayload {
  userId: string
  type: string
}

/**
 * Notify that a task is ready for processing.
 * Emits an in-process event (for the embedded worker) and fires a
 * best-effort HTTP self-kick to /api/tasks/process (covers both
 * embedded and standalone V2 worker modes).
 */
export function kickTaskProcessing(payload: TaskReadyPayload): void {
  taskReadyEmitter.emit(TASK_READY_EVENT, payload)

  const token = process.env.TASK_ENGINE_INTERNAL_TOKEN ?? "embedded-worker"
  const port = process.env.PORT || "3000"
  const url = `http://localhost:${port}/api/tasks/process?userId=${encodeURIComponent(payload.userId)}&type=${encodeURIComponent(payload.type)}`

  fetch(url, {
    method: "POST",
    headers: { "x-task-engine-token": token },
  }).catch(() => {
    // Silently ignored — polling will eventually pick it up
  })
}
