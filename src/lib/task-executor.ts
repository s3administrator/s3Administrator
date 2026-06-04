/**
 * Task executor that calls the process route logic directly,
 * bypassing HTTP when running in the worker process.
 *
 * The actual execution logic lives in /api/tasks/process/route.ts.
 * This module re-exports a function that constructs a minimal Request,
 * invokes the POST handler, and returns the parsed JSON response.
 *
 * When called from the standalone worker process the heavy S3 work
 * (multipart copies, streaming downloads, etc.) runs inside the
 * worker's Node process instead of the Next.js app process, keeping
 * the app responsive for UI operations like bucket listing.
 */

import { POST } from "@/app/api/tasks/process/route"

export interface TaskExecutionResult {
  processed?: boolean
  taskId?: string
  taskType?: string
  taskStatus?: string
  runCount?: number
  attempts?: number
  lastError?: string | null
  taskUserId?: string
  done?: boolean
  [key: string]: unknown
}

export async function executeTaskForUser(
  userId: string,
  internalToken: string,
  type?: string
): Promise<TaskExecutionResult> {
  const typeParam = type ? `&type=${encodeURIComponent(type)}` : ""
  const url = `http://localhost/api/tasks/process?userId=${encodeURIComponent(userId)}${typeParam}`

  const request = new Request(url, {
    method: "POST",
    headers: {
      "x-task-engine-token": internalToken,
    },
  })

  const response = await POST(request)
  return (await response.json()) as TaskExecutionResult
}
