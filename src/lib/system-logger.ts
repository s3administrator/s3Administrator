import { promises as fs } from "fs"
import path from "path"

export type SystemLogLevel = "error" | "warn" | "info"
export type SystemLogSource = "app" | "db"

export type SystemLogEntry = {
  id: string
  createdAt: string
  source: SystemLogSource
  level: SystemLogLevel
  message: string
  route?: string
  metadata?: Record<string, unknown>
}

const DEFAULT_LOG_PATH = path.join(process.cwd(), "logs", "system.log")
const LOG_FILE_PATH =
  process.env.SYSTEM_LOG_FILE_PATH?.trim() || DEFAULT_LOG_PATH
const MAX_LOG_MESSAGE_LENGTH = Math.max(
  1000,
  Number.parseInt(process.env.SYSTEM_LOG_MAX_MESSAGE_LENGTH ?? "50000", 10) || 50000
)

const globalForSystemLogger = globalThis as unknown as {
  __systemLoggerPatched?: boolean
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify(String(value))
  }
}

function toMessageText(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack || value.message
  return safeStringify(value)
}

function serializeConsoleArgs(args: unknown[]): string {
  return args.map((arg) => toMessageText(arg)).join(" ")
}

function normalizeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  const next: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      next[key] = value
      continue
    }

    try {
      next[key] = JSON.parse(safeStringify(value))
    } catch {
      next[key] = String(value)
    }
  }

  return Object.keys(next).length > 0 ? next : undefined
}

export async function logSystemEvent(input: {
  source: SystemLogSource
  level: SystemLogLevel
  message: string
  route?: string
  metadata?: Record<string, unknown>
}) {
  const entry: SystemLogEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    source: input.source,
    level: input.level,
    message: input.message.slice(0, MAX_LOG_MESSAGE_LENGTH),
    route: input.route ? input.route.slice(0, 256) : undefined,
    metadata: normalizeMetadata(input.metadata),
  }

  try {
    await fs.mkdir(path.dirname(LOG_FILE_PATH), { recursive: true })
    await fs.appendFile(LOG_FILE_PATH, `${safeStringify(entry)}\n`, "utf8")
  } catch {
    // Never throw from logging.
  }
}

export function parseSystemLogLine(line: string): SystemLogEntry | null {
  if (!line.trim()) return null

  try {
    const parsed = JSON.parse(line) as Partial<SystemLogEntry>
    if (!parsed || typeof parsed !== "object") return null
    if (typeof parsed.id !== "string") return null
    if (typeof parsed.createdAt !== "string") return null
    if (parsed.source !== "app" && parsed.source !== "db") return null
    if (
      parsed.level !== "error" &&
      parsed.level !== "warn" &&
      parsed.level !== "info"
    ) {
      return null
    }
    if (typeof parsed.message !== "string") return null

    return {
      id: parsed.id,
      createdAt: parsed.createdAt,
      source: parsed.source,
      level: parsed.level,
      message: parsed.message,
      route: typeof parsed.route === "string" ? parsed.route : undefined,
      metadata:
        parsed.metadata && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : undefined,
    }
  } catch {
    return null
  }
}

export function getSystemLogFilePath() {
  return LOG_FILE_PATH
}

export function setupServerErrorLogging() {
  if (typeof window !== "undefined") return
  if (globalForSystemLogger.__systemLoggerPatched) return
  globalForSystemLogger.__systemLoggerPatched = true

  const originalConsoleError = console.error.bind(console)
  const originalConsoleWarn = console.warn.bind(console)
  const originalConsoleInfo = console.info.bind(console)
  const originalConsoleLog = console.log.bind(console)

  console.error = (...args: unknown[]) => {
    void logSystemEvent({
      source: "app",
      level: "error",
      message: serializeConsoleArgs(args),
      metadata: { channel: "console.error" },
    })
    originalConsoleError(...args)
  }

  console.warn = (...args: unknown[]) => {
    void logSystemEvent({
      source: "app",
      level: "warn",
      message: serializeConsoleArgs(args),
      metadata: { channel: "console.warn" },
    })
    originalConsoleWarn(...args)
  }

  console.info = (...args: unknown[]) => {
    void logSystemEvent({
      source: "app",
      level: "info",
      message: serializeConsoleArgs(args),
      metadata: { channel: "console.info" },
    })
    originalConsoleInfo(...args)
  }

  console.log = (...args: unknown[]) => {
    void logSystemEvent({
      source: "app",
      level: "info",
      message: serializeConsoleArgs(args),
      metadata: { channel: "console.log" },
    })
    originalConsoleLog(...args)
  }

  process.on("uncaughtException", (error) => {
    void logSystemEvent({
      source: "app",
      level: "error",
      message: error.message || "uncaught_exception",
      metadata: {
        channel: "process.uncaughtException",
        stack: error.stack ?? null,
      },
    })
  })

  process.on("unhandledRejection", (reason) => {
    void logSystemEvent({
      source: "app",
      level: "error",
      message: "unhandled_rejection",
      metadata: {
        channel: "process.unhandledRejection",
        reason: toMessageText(reason),
      },
    })
  })
}
