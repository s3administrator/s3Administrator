"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, ArrowUpDown, RotateCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type SystemLog = {
  id: string
  createdAt: string
  source: "app" | "db"
  level: "error" | "warn" | "info"
  message: string
  route?: string
  metadata?: Record<string, unknown>
}

type SortField = "createdAt" | "source" | "level"
type SortDirection = "asc" | "desc"

export default function AdminLogsPage() {
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState("")
  const [source, setSource] = useState("all")
  const [level, setLevel] = useState("all")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [sortBy, setSortBy] = useState<SortField>("createdAt")
  const [sortDir, setSortDir] = useState<SortDirection>("desc")

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set("page", String(page))
    params.set("sortBy", sortBy)
    params.set("sortDir", sortDir)
    if (query.trim()) params.set("q", query.trim())
    if (source !== "all") params.set("source", source)
    if (level !== "all") params.set("level", level)
    if (dateFrom) params.set("dateFrom", dateFrom)
    if (dateTo) params.set("dateTo", dateTo)
    return params.toString()
  }, [dateFrom, dateTo, level, page, query, sortBy, sortDir, source])

  const { data, isLoading } = useQuery<{
    logs: SystemLog[]
    total: number
    limit: number
    logFilePath: string
  }>({
    queryKey: ["admin-system-logs", queryString],
    queryFn: async () => {
      const res = await fetch(`/api/admin/logs?${queryString}`)
      if (!res.ok) throw new Error("Failed to load system logs")
      return res.json()
    },
  })

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  const onSort = (field: SortField) => {
    setPage(1)
    if (sortBy === field) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"))
      return
    }
    setSortBy(field)
    setSortDir(field === "createdAt" ? "desc" : "asc")
  }

  const sortIcon = (field: SortField) => {
    if (sortBy !== field) return <ArrowUpDown className="h-3.5 w-3.5" />
    return sortDir === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    )
  }

  const resetFilters = () => {
    setPage(1)
    setQuery("")
    setSource("all")
    setLevel("all")
    setDateFrom("")
    setDateTo("")
    setSortBy("createdAt")
    setSortDir("desc")
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">System Logs</h1>
          <p className="text-sm text-muted-foreground">
            {data?.total ?? 0} log entries
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Input
            value={query}
            onChange={(e) => {
              setPage(1)
              setQuery(e.target.value)
            }}
            placeholder="Search message/metadata"
            className="w-full sm:w-80"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={resetFilters}
            className="gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Select
          value={source}
          onValueChange={(value) => {
            setPage(1)
            setSource(value)
          }}
        >
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="app">app</SelectItem>
            <SelectItem value="db">db</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={level}
          onValueChange={(value) => {
            setPage(1)
            setLevel(value)
          }}
        >
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            <SelectItem value="error">error</SelectItem>
            <SelectItem value="warn">warn</SelectItem>
            <SelectItem value="info">info</SelectItem>
          </SelectContent>
        </Select>

        <Input
          type="date"
          className="h-8 w-40 text-xs"
          value={dateFrom}
          onChange={(e) => {
            setPage(1)
            setDateFrom(e.target.value)
          }}
        />
        <Input
          type="date"
          className="h-8 w-40 text-xs"
          value={dateTo}
          onChange={(e) => {
            setPage(1)
            setDateTo(e.target.value)
          }}
        />
      </div>

      {!isLoading && data?.logFilePath ? (
        <p className="mb-3 text-xs text-muted-foreground">
          File: {data.logFilePath}
        </p>
      ) : null}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("createdAt")}
                    >
                      Time (UTC) {sortIcon("createdAt")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("source")}
                    >
                      Source {sortIcon("source")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("level")}
                    >
                      Level {sortIcon("level")}
                    </Button>
                  </TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Metadata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(log.createdAt).toLocaleString("en-US", {
                        timeZone: "UTC",
                      })}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {log.source}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={log.level === "error" ? "destructive" : "outline"}
                        className="text-xs"
                      >
                        {log.level}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="max-w-56 truncate font-mono text-xs text-muted-foreground"
                      title={log.route ?? ""}
                    >
                      {log.route ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-[40rem] whitespace-pre-wrap break-all text-xs">
                      {log.message}
                    </TableCell>
                    <TableCell
                      className="max-w-[40rem] whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground"
                      title={log.metadata ? JSON.stringify(log.metadata) : ""}
                    >
                      {log.metadata ? JSON.stringify(log.metadata) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {(data?.logs.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No logs found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
