"use client"

import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { Clock3, Cpu, HardDrive, MemoryStick, Server } from "lucide-react"

type MetricPoint = {
  recordedAt: string
  hostCpuPercent: number | null
  hostMemoryUsedBytes: number | null
  hostMemoryTotalBytes: number | null
  hostDiskUsedBytes: number | null
  hostDiskTotalBytes: number | null
  appCpuPercent: number | null
  appMemoryUsedBytes: number | null
  appMemoryLimitBytes: number | null
}

type ServerMetricsResponse = {
  range: "24h" | "7d"
  resolution: "1m" | "5m" | "15m" | "1h"
  latest: MetricPoint | null
  series: MetricPoint[]
  sampleCount: number
  generatedAt: string
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—"
  return `${value.toFixed(2)}%`
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return "—"
  if (value === 0) return "0 B"

  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const scaled = value / 1024 ** i
  return `${scaled.toFixed(scaled >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

function toUsagePercent(used: number | null, total: number | null) {
  if (
    used === null ||
    total === null ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null
  }

  return Math.max(0, Math.min(100, (used / total) * 100))
}

function MetricBarChart({
  title,
  series,
  getValue,
  className,
}: {
  title: string
  series: MetricPoint[]
  getValue: (point: MetricPoint) => number | null
  className?: string
}) {
  const values = useMemo(
    () =>
      series
        .map((point) => getValue(point))
        .filter((value): value is number => value !== null && Number.isFinite(value)),
    [getValue, series]
  )

  if (series.length === 0 || values.length === 0) {
    return (
      <Card className={className}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No samples yet.</p>
        </CardContent>
      </Card>
    )
  }

  const max = Math.max(1, ...values)
  const step = Math.max(1, Math.ceil(series.length / 84))
  const compactSeries = series.filter((_, index) => index % step === 0)

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex h-36 items-end gap-1">
          {compactSeries.map((point) => {
            const value = getValue(point)
            const hasValue = value !== null && Number.isFinite(value)
            const height = hasValue ? Math.max(4, (value / max) * 110) : 4
            return (
              <div
                key={point.recordedAt}
                className={cn(
                  "w-full rounded-sm",
                  hasValue ? "bg-primary/70" : "bg-muted"
                )}
                style={{ height }}
                title={`${new Date(point.recordedAt).toLocaleString()} • ${
                  hasValue ? value.toFixed(2) : "n/a"
                }`}
              />
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

export default function AdminServerPage() {
  const { data, isLoading } = useQuery<ServerMetricsResponse>({
    queryKey: ["admin-server-metrics", "7d", "1h"],
    queryFn: async () => {
      const res = await fetch("/api/admin/server-metrics?range=7d&resolution=1h")
      if (!res.ok) throw new Error("Failed to load server metrics")
      return res.json()
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const latest = data?.latest ?? null
  const hostMemoryPercent = toUsagePercent(
    latest?.hostMemoryUsedBytes ?? null,
    latest?.hostMemoryTotalBytes ?? null
  )
  const hostDiskPercent = toUsagePercent(
    latest?.hostDiskUsedBytes ?? null,
    latest?.hostDiskTotalBytes ?? null
  )
  const appMemoryPercent = toUsagePercent(
    latest?.appMemoryUsedBytes ?? null,
    latest?.appMemoryLimitBytes ?? null
  )

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Server Metrics</h1>
        <p className="text-sm text-muted-foreground">
          Host and app container resource usage sampled every minute
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          <>
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Server className="h-4 w-4" /> Host CPU
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {formatPercent(latest?.hostCpuPercent ?? null)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <MemoryStick className="h-4 w-4" /> Host RAM
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatPercent(hostMemoryPercent)}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(latest?.hostMemoryUsedBytes ?? null)} /{" "}
                  {formatBytes(latest?.hostMemoryTotalBytes ?? null)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <HardDrive className="h-4 w-4" /> Host Disk
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatPercent(hostDiskPercent)}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(latest?.hostDiskUsedBytes ?? null)} /{" "}
                  {formatBytes(latest?.hostDiskTotalBytes ?? null)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Cpu className="h-4 w-4" /> App CPU
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {formatPercent(latest?.appCpuPercent ?? null)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <MemoryStick className="h-4 w-4" /> App RAM
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatPercent(appMemoryPercent)}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(latest?.appMemoryUsedBytes ?? null)} /{" "}
                  {formatBytes(latest?.appMemoryLimitBytes ?? null)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Clock3 className="h-4 w-4" /> Last Sample
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-base font-semibold">
                  {latest?.recordedAt
                    ? new Date(latest.recordedAt).toLocaleString()
                    : "No sample yet"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {data?.sampleCount ?? 0} raw points in selected range
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <MetricBarChart
          title="Host CPU (Last 7 Days)"
          series={data?.series ?? []}
          getValue={(point) => point.hostCpuPercent}
        />
        <MetricBarChart
          title="Host RAM % (Last 7 Days)"
          series={data?.series ?? []}
          getValue={(point) =>
            toUsagePercent(point.hostMemoryUsedBytes, point.hostMemoryTotalBytes)
          }
        />
        <MetricBarChart
          title="Host Disk % (Last 7 Days)"
          series={data?.series ?? []}
          getValue={(point) =>
            toUsagePercent(point.hostDiskUsedBytes, point.hostDiskTotalBytes)
          }
        />
        <MetricBarChart
          title="App CPU (Last 7 Days)"
          series={data?.series ?? []}
          getValue={(point) => point.appCpuPercent}
        />
        <MetricBarChart
          title="App RAM % (Last 7 Days)"
          series={data?.series ?? []}
          getValue={(point) =>
            toUsagePercent(point.appMemoryUsedBytes, point.appMemoryLimitBytes)
          }
          className="xl:col-span-2"
        />
      </div>
    </div>
  )
}
