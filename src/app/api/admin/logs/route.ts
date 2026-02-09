import { promises as fs } from "fs"
import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import {
  getSystemLogFilePath,
  parseSystemLogLine,
  type SystemLogEntry,
} from "@/lib/system-logger"

type SortField = "createdAt" | "source" | "level"
type SortDirection = "asc" | "desc"

const MAX_LOG_LINES = 6000

function safeQueryString(searchParams: URLSearchParams, key: string, max = 255) {
  const value = (searchParams.get(key) ?? "").trim()
  if (!value) return ""
  return value.slice(0, max)
}

function parseDateStart(value: string): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

function parseDateEnd(value: string): Date | null {
  const start = parseDateStart(value)
  if (!start) return null
  const end = new Date(start)
  end.setUTCHours(23, 59, 59, 999)
  return end
}

function parseSortField(raw: string): SortField {
  if (raw === "source" || raw === "level") return raw
  return "createdAt"
}

function parseSortDirection(raw: string): SortDirection {
  return raw === "asc" ? "asc" : "desc"
}

function applyFilters(
  entries: SystemLogEntry[],
  options: {
    source: string
    level: string
    query: string
    dateFrom: Date | null
    dateTo: Date | null
  }
) {
  return entries.filter((entry) => {
    if (options.source && options.source !== "all" && entry.source !== options.source) {
      return false
    }

    if (options.level && options.level !== "all" && entry.level !== options.level) {
      return false
    }

    const createdAt = new Date(entry.createdAt)
    if (options.dateFrom && createdAt < options.dateFrom) return false
    if (options.dateTo && createdAt > options.dateTo) return false

    if (options.query) {
      const query = options.query.toLowerCase()
      const text = [
        entry.message,
        entry.route ?? "",
        entry.source,
        entry.level,
        entry.metadata ? JSON.stringify(entry.metadata) : "",
      ]
        .join(" ")
        .toLowerCase()

      if (!text.includes(query)) return false
    }

    return true
  })
}

function sortLogs(entries: SystemLogEntry[], sortBy: SortField, sortDir: SortDirection) {
  const sorted = [...entries]

  sorted.sort((a, b) => {
    let cmp = 0
    if (sortBy === "source") {
      cmp = a.source.localeCompare(b.source)
    } else if (sortBy === "level") {
      cmp = a.level.localeCompare(b.level)
    } else {
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    }
    return sortDir === "asc" ? cmp : -cmp
  })

  return sorted
}

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10))
  const requestedLimit = parseInt(searchParams.get("limit") ?? "50", 10)
  const limit = Number.isNaN(requestedLimit)
    ? 50
    : Math.max(10, Math.min(100, requestedLimit))
  const skip = (page - 1) * limit

  const source = safeQueryString(searchParams, "source", 16)
  const level = safeQueryString(searchParams, "level", 16)
  const query = safeQueryString(searchParams, "q", 120)
  const dateFrom = parseDateStart(safeQueryString(searchParams, "dateFrom", 32))
  const dateTo = parseDateEnd(safeQueryString(searchParams, "dateTo", 32))
  const sortBy = parseSortField(safeQueryString(searchParams, "sortBy", 16))
  const sortDir = parseSortDirection(safeQueryString(searchParams, "sortDir", 8))

  const filePath = getSystemLogFilePath()
  const fileContent = await fs.readFile(filePath, "utf8").catch(() => "")

  const parsedEntries = fileContent
    .split("\n")
    .slice(-MAX_LOG_LINES)
    .map((line) => parseSystemLogLine(line))
    .filter((entry): entry is SystemLogEntry => Boolean(entry))

  const filtered = applyFilters(parsedEntries, {
    source,
    level,
    query,
    dateFrom,
    dateTo,
  })

  const sorted = sortLogs(filtered, sortBy, sortDir)
  const paged = sorted.slice(skip, skip + limit)

  return NextResponse.json({
    logs: paged,
    total: filtered.length,
    page,
    limit,
    sortBy,
    sortDir,
    logFilePath: filePath,
  })
}

