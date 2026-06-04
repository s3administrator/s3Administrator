type Level = "info" | "warn" | "error" | "debug"

export type SystemLogEvent = {
  source?: string
  level: Level
  message: string
  route?: string
  metadata?: Record<string, unknown>
}

export async function logSystemEvent(event: SystemLogEvent): Promise<void> {
  const { level, message, source, route, metadata } = event
  const tag = source ? `[${source}]` : "[app]"
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log
  fn(tag, message, route ?? "", metadata ?? "")
}

export function setupServerErrorLogging(): void {
  if (process.env.NEXT_RUNTIME === "edge") return
  process.on("uncaughtException", (err) => {
    console.error("[uncaught]", err)
  })
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason)
  })
}
