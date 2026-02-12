"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
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

type RangeKey = "1h" | "1d" | "7d"
type ResolutionKey = "1m" | "5m" | "15m" | "1h"

type ServerMetricsResponse = {
  range: RangeKey
  resolution: ResolutionKey
  latest: MetricPoint | null
  series: MetricPoint[]
  sampleCount: number
  generatedAt: string
}

const EMPTY_SERIES: MetricPoint[] = []

const RANGE_TO_LABEL: Record<RangeKey, string> = {
  "1h": "Last 1 Hour",
  "1d": "Last 1 Day",
  "7d": "Last 7 Days",
}

const RANGE_TO_RESOLUTION: Record<RangeKey, ResolutionKey> = {
  "1h": "1m",
  "1d": "5m",
  "7d": "1h",
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

function formatResolution(resolution: ResolutionKey) {
  if (resolution === "1m") return "1 minute"
  if (resolution === "5m") return "5 minutes"
  if (resolution === "15m") return "15 minutes"
  return "1 hour"
}

function formatAxisTimestamp(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "—"
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
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
  const [hoveredPoint, setHoveredPoint] = useState<{
    recordedAt: string
    value: number | null
  } | null>(null)

  const summary = useMemo(() => {
    if (values.length === 0) return null

    const latest = values[values.length - 1]
    const min = Math.min(...values)
    const max = Math.max(...values)
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length
    return { latest, min, max, avg }
  }, [values])

  if (series.length === 0 || !summary) {
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
  const axisMax = Math.max(10, Math.ceil(max / 10) * 10)
  const yAxisTicks = [axisMax, axisMax / 2, 0]
  const firstPoint = compactSeries[0] ?? null
  const middlePoint = compactSeries[Math.floor((compactSeries.length - 1) / 2)] ?? null
  const lastPoint = compactSeries[compactSeries.length - 1] ?? null
  const activePoint = hoveredPoint ?? (lastPoint ? { recordedAt: lastPoint.recordedAt, value: summary.latest } : null)

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div className="rounded border px-2 py-1">
            <p className="text-muted-foreground">Latest</p>
            <p className="font-semibold">{formatPercent(summary.latest)}</p>
          </div>
          <div className="rounded border px-2 py-1">
            <p className="text-muted-foreground">Min</p>
            <p className="font-semibold">{formatPercent(summary.min)}</p>
          </div>
          <div className="rounded border px-2 py-1">
            <p className="text-muted-foreground">Max</p>
            <p className="font-semibold">{formatPercent(summary.max)}</p>
          </div>
          <div className="rounded border px-2 py-1">
            <p className="text-muted-foreground">Avg</p>
            <p className="font-semibold">{formatPercent(summary.avg)}</p>
          </div>
        </div>

        <div className="grid grid-cols-[40px_1fr] gap-2">
          <div className="flex h-36 flex-col justify-between text-[10px] text-muted-foreground">
            {yAxisTicks.map((tick, index) => (
              <span key={`${tick}-${index}`} className="leading-none">
                {tick.toFixed(0)}%
              </span>
            ))}
          </div>

          <div className="min-w-0">
            <div
              className="relative h-36 border-b border-l"
              onMouseLeave={() => setHoveredPoint(null)}
            >
              <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
                {yAxisTicks.map((tick, index) => (
                  <div key={`line-${tick}-${index}`} className="border-t border-dashed border-border/60" />
                ))}
              </div>

              <div className="relative flex h-full items-end gap-1 px-1 pb-1">
                {compactSeries.map((point) => {
                  const value = getValue(point)
                  const hasValue = value !== null && Number.isFinite(value)
                  const height = hasValue ? Math.max(4, (value / axisMax) * 100) : 4
                  return (
                    <div
                      key={point.recordedAt}
                      className={cn(
                        "w-full rounded-sm",
                        hasValue ? "bg-primary/70 hover:bg-primary" : "bg-muted"
                      )}
                      style={{ height: `${height}%` }}
                      title={`${new Date(point.recordedAt).toLocaleString()} • ${
                        hasValue ? `${value.toFixed(2)}%` : "n/a"
                      }`}
                      tabIndex={0}
                      onMouseEnter={() =>
                        setHoveredPoint({
                          recordedAt: point.recordedAt,
                          value: hasValue ? value : null,
                        })
                      }
                      onFocus={() =>
                        setHoveredPoint({
                          recordedAt: point.recordedAt,
                          value: hasValue ? value : null,
                        })
                      }
                      onBlur={() => setHoveredPoint(null)}
                    />
                  )
                })}
              </div>
            </div>

            <div className="mt-1 flex justify-between gap-2 text-[10px] text-muted-foreground">
              <span className="max-w-[33%] truncate">{firstPoint ? formatAxisTimestamp(firstPoint.recordedAt) : "—"}</span>
              <span className="max-w-[33%] truncate text-center">
                {middlePoint ? formatAxisTimestamp(middlePoint.recordedAt) : "—"}
              </span>
              <span className="max-w-[33%] truncate text-right">{lastPoint ? formatAxisTimestamp(lastPoint.recordedAt) : "—"}</span>
            </div>
          </div>
        </div>

        <div className="mt-2 rounded border bg-muted/30 px-2 py-1 text-xs">
          <span className="text-muted-foreground">Hovered:</span>{" "}
          {activePoint
            ? `${new Date(activePoint.recordedAt).toLocaleString()} • ${formatPercent(
                activePoint.value
              )}`
            : "—"}
        </div>
      </CardContent>
    </Card>
  )
}

export default function AdminServerPage() {
  const [range, setRange] = useState<RangeKey>("7d")
  const resolution = RANGE_TO_RESOLUTION[range]

  const { data, isLoading } = useQuery<ServerMetricsResponse>({
    queryKey: ["admin-server-metrics", range, resolution],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/server-metrics?range=${range}&resolution=${resolution}`
      )
      if (!res.ok) throw new Error("Failed to load server metrics")
      return res.json()
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const latest = data?.latest ?? null
  const series = data?.series ?? EMPTY_SERIES
  const selectedRangeLabel = RANGE_TO_LABEL[data?.range ?? range]
  const selectedResolution = data?.resolution ?? resolution

  const recentPoints = useMemo(() => {
    return [...series].slice(-10).reverse()
  }, [series])

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
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold sm:text-2xl">Server Metrics</h1>
        <p className="text-sm text-muted-foreground">
          Host and app container resource usage sampled every minute
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {(["1h", "1d", "7d"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={range === option ? "default" : "outline"}
              onClick={() => setRange(option)}
              aria-pressed={range === option}
            >
              {option.toUpperCase()}
            </Button>
          ))}
        </div>
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
                  {data?.sampleCount ?? 0} raw points • {selectedRangeLabel} •{" "}
                  {formatResolution(selectedResolution)} resolution
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <MetricBarChart
          title={`Host CPU (${selectedRangeLabel})`}
          series={series}
          getValue={(point) => point.hostCpuPercent}
        />
        <MetricBarChart
          title={`Host RAM % (${selectedRangeLabel})`}
          series={series}
          getValue={(point) =>
            toUsagePercent(point.hostMemoryUsedBytes, point.hostMemoryTotalBytes)
          }
        />
        <MetricBarChart
          title={`Host Disk % (${selectedRangeLabel})`}
          series={series}
          getValue={(point) =>
            toUsagePercent(point.hostDiskUsedBytes, point.hostDiskTotalBytes)
          }
        />
        <MetricBarChart
          title={`App CPU (${selectedRangeLabel})`}
          series={series}
          getValue={(point) => point.appCpuPercent}
        />
        <MetricBarChart
          title={`App RAM % (${selectedRangeLabel})`}
          series={series}
          getValue={(point) =>
            toUsagePercent(point.appMemoryUsedBytes, point.appMemoryLimitBytes)
          }
          className="xl:col-span-2"
        />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Recent Numeric Samples</CardTitle>
          <p className="text-xs text-muted-foreground">
            Last 10 plotted points for debugging.
          </p>
        </CardHeader>
        <CardContent>
          {recentPoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">No samples yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Time</th>
                    <th className="px-2 py-2 font-medium">Host CPU</th>
                    <th className="px-2 py-2 font-medium">Host RAM%</th>
                    <th className="px-2 py-2 font-medium">Host Disk%</th>
                    <th className="px-2 py-2 font-medium">App CPU</th>
                    <th className="px-2 py-2 font-medium">App RAM%</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPoints.map((point) => (
                    <tr key={point.recordedAt} className="border-b last:border-0">
                      <td className="px-2 py-2">
                        {new Date(point.recordedAt).toLocaleString()}
                      </td>
                      <td className="px-2 py-2">{formatPercent(point.hostCpuPercent)}</td>
                      <td className="px-2 py-2">
                        {formatPercent(
                          toUsagePercent(
                            point.hostMemoryUsedBytes,
                            point.hostMemoryTotalBytes
                          )
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {formatPercent(
                          toUsagePercent(point.hostDiskUsedBytes, point.hostDiskTotalBytes)
                        )}
                      </td>
                      <td className="px-2 py-2">{formatPercent(point.appCpuPercent)}</td>
                      <td className="px-2 py-2">
                        {formatPercent(
                          toUsagePercent(
                            point.appMemoryUsedBytes,
                            point.appMemoryLimitBytes
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
