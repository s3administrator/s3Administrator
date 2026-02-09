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

export default function AdminActionsPage() {
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState("")
  const [eventType, setEventType] = useState("all")

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set("page", String(page))
    if (query.trim()) params.set("q", query.trim())
    if (eventType !== "all") params.set("eventType", eventType)
    return params.toString()
  }, [page, query, eventType])

  const { data, isLoading } = useQuery<{
    events: ActionEvent[]
    total: number
    limit: number
  }>({
    queryKey: ["admin-actions", page, query, eventType],
    queryFn: async () => {
      const res = await fetch(`/api/admin/actions?${queryString}`)
      if (!res.ok) throw new Error("Failed to load action logs")
      return res.json()
    },
  })

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">User Actions</h1>
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
            placeholder="Search path, event, or user email"
            className="w-full sm:w-80"
          />
          <Select
            value={eventType}
            onValueChange={(value) => {
              setPage(1)
              setEventType(value)
            }}
          >
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="Event type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="page_view">Page Views</SelectItem>
              <SelectItem value="click">Clicks</SelectItem>
              <SelectItem value="form_submit">Form Submit</SelectItem>
              <SelectItem value="api_call">API Calls</SelectItem>
              <SelectItem value="auth">Auth</SelectItem>
            </SelectContent>
          </Select>
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
                  <TableHead>When (UTC)</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Target</TableHead>
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
                    <TableCell
                      className="max-w-60 truncate text-xs text-muted-foreground"
                      title={event.target ?? ""}
                    >
                      {event.target ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {(data?.events.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
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
