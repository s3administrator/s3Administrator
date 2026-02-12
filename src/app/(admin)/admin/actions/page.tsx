"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
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
import { ArrowDown, ArrowUp, ArrowUpDown, RotateCcw } from "lucide-react"

type ActionEvent = {
  id: string
  eventType: string
  eventName: string
  path: string
  method: string | null
  target: string | null
  metadata: unknown
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  user: {
    id: string
    name: string | null
    email: string
  } | null
}

type SortField =
  | "createdAt"
  | "user"
  | "eventType"
  | "eventName"
  | "path"
  | "method"
  | "target"
  | "ipAddress"

type SortDirection = "asc" | "desc"

type ActionFilters = {
  dateFrom: string
  dateTo: string
  user: string
  eventType: string
  eventName: string
  path: string
  method: string
  target: string
  ipAddress: string
}

const defaultFilters: ActionFilters = {
  dateFrom: "",
  dateTo: "",
  user: "",
  eventType: "all",
  eventName: "",
  path: "",
  method: "all",
  target: "",
  ipAddress: "",
}

export default function AdminActionsPage() {
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<ActionFilters>(defaultFilters)
  const [sortBy, setSortBy] = useState<SortField>("createdAt")
  const [sortDir, setSortDir] = useState<SortDirection>("desc")

  const setFilter = (key: keyof ActionFilters, value: string) => {
    setPage(1)
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const onSort = (field: SortField) => {
    setPage(1)
    if (sortBy === field) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"))
      return
    }
    setSortBy(field)
    setSortDir(field === "createdAt" ? "desc" : "asc")
  }

  const resetFilters = () => {
    setPage(1)
    setQuery("")
    setFilters(defaultFilters)
    setSortBy("createdAt")
    setSortDir("desc")
  }

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set("page", String(page))
    params.set("sortBy", sortBy)
    params.set("sortDir", sortDir)

    if (query.trim()) params.set("q", query.trim())
    if (filters.dateFrom) params.set("dateFrom", filters.dateFrom)
    if (filters.dateTo) params.set("dateTo", filters.dateTo)
    if (filters.user.trim()) params.set("user", filters.user.trim())
    if (filters.eventType !== "all") params.set("eventType", filters.eventType)
    if (filters.eventName.trim()) params.set("eventName", filters.eventName.trim())
    if (filters.path.trim()) params.set("path", filters.path.trim())
    if (filters.method !== "all") params.set("method", filters.method)
    if (filters.target.trim()) params.set("target", filters.target.trim())
    if (filters.ipAddress.trim()) params.set("ipAddress", filters.ipAddress.trim())

    return params.toString()
  }, [filters, page, query, sortBy, sortDir])

  const { data, isLoading } = useQuery<{
    events: ActionEvent[]
    total: number
    limit: number
    sortBy: SortField
    sortDir: SortDirection
  }>({
    queryKey: ["admin-actions", queryString],
    queryFn: async () => {
      const res = await fetch(`/api/admin/actions?${queryString}`)
      if (!res.ok) throw new Error("Failed to load action logs")
      return res.json()
    },
  })

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1
  const sortIcon = (field: SortField) => {
    if (sortBy !== field) return <ArrowUpDown className="h-3.5 w-3.5" />
    return sortDir === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    )
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">User Actions</h1>
          <p className="text-sm text-muted-foreground">
            {data?.total ?? 0} tracked events
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Input
            value={query}
            onChange={(e) => {
              setPage(1)
              setQuery(e.target.value)
            }}
            placeholder="Global search"
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
                      When (UTC) {sortIcon("createdAt")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("user")}
                    >
                      User {sortIcon("user")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("eventType")}
                    >
                      Type {sortIcon("eventType")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("eventName")}
                    >
                      Event {sortIcon("eventName")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("path")}
                    >
                      Path {sortIcon("path")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("method")}
                    >
                      Method {sortIcon("method")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("target")}
                    >
                      Target {sortIcon("target")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="px-0"
                      onClick={() => onSort("ipAddress")}
                    >
                      IP {sortIcon("ipAddress")}
                    </Button>
                  </TableHead>
                </TableRow>
                <TableRow>
                  <TableHead>
                    <div className="flex gap-1">
                      <Input
                        type="date"
                        className="h-8 text-xs"
                        value={filters.dateFrom}
                        onChange={(e) => setFilter("dateFrom", e.target.value)}
                      />
                      <Input
                        type="date"
                        className="h-8 text-xs"
                        value={filters.dateTo}
                        onChange={(e) => setFilter("dateTo", e.target.value)}
                      />
                    </div>
                  </TableHead>
                  <TableHead>
                    <Input
                      className="h-8 text-xs"
                      placeholder="email or name"
                      value={filters.user}
                      onChange={(e) => setFilter("user", e.target.value)}
                    />
                  </TableHead>
                  <TableHead>
                    <Select
                      value={filters.eventType}
                      onValueChange={(value) => setFilter("eventType", value)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="page_view">page_view</SelectItem>
                        <SelectItem value="click">click</SelectItem>
                        <SelectItem value="form_submit">form_submit</SelectItem>
                        <SelectItem value="api_call">api_call</SelectItem>
                        <SelectItem value="s3_action">s3_action</SelectItem>
                        <SelectItem value="auth">auth</SelectItem>
                        <SelectItem value="error">error</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableHead>
                  <TableHead>
                    <Input
                      className="h-8 text-xs"
                      placeholder="event name"
                      value={filters.eventName}
                      onChange={(e) => setFilter("eventName", e.target.value)}
                    />
                  </TableHead>
                  <TableHead>
                    <Input
                      className="h-8 text-xs"
                      placeholder="/dashboard"
                      value={filters.path}
                      onChange={(e) => setFilter("path", e.target.value)}
                    />
                  </TableHead>
                  <TableHead>
                    <Select
                      value={filters.method}
                      onValueChange={(value) => setFilter("method", value)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="GET">GET</SelectItem>
                        <SelectItem value="POST">POST</SelectItem>
                        <SelectItem value="PUT">PUT</SelectItem>
                        <SelectItem value="PATCH">PATCH</SelectItem>
                        <SelectItem value="DELETE">DELETE</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableHead>
                  <TableHead>
                    <Input
                      className="h-8 text-xs"
                      placeholder="target"
                      value={filters.target}
                      onChange={(e) => setFilter("target", e.target.value)}
                    />
                  </TableHead>
                  <TableHead>
                    <Input
                      className="h-8 text-xs"
                      placeholder="ip address"
                      value={filters.ipAddress}
                      onChange={(e) => setFilter("ipAddress", e.target.value)}
                    />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(event.createdAt).toLocaleString("en-US", {
                        timeZone: "UTC",
                      })}
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        <p className="font-medium">
                          {event.user?.name ?? event.user?.email ?? "anonymous"}
                        </p>
                        {event.user?.email ? (
                          <p className="text-muted-foreground">{event.user.email}</p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {event.eventType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{event.eventName}</TableCell>
                    <TableCell className="max-w-60 truncate text-xs" title={event.path}>
                      {event.path}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {event.method ?? "—"}
                    </TableCell>
                    <TableCell
                      className="max-w-60 truncate text-xs text-muted-foreground"
                      title={event.target ?? ""}
                    >
                      {event.target ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {event.ipAddress ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {(data?.events.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      No events found.
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
