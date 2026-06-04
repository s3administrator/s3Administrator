import { NextResponse } from "next/server"

export function isBackgroundTaskSchemaOutdated(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as {
    code?: unknown
    meta?: {
      modelName?: unknown
      column?: unknown
    }
  }

  return (
    candidate.code === "P2022" &&
    candidate.meta?.modelName === "BackgroundTask"
  )
}

export function backgroundTaskSchemaOutdatedResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Database schema is out of date for background tasks. Run `make community-migrate` and restart the app.",
    },
    { status: 503 }
  )
}
