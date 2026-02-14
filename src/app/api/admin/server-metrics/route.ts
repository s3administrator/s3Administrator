import { NextResponse } from "next/server"
import { communityGuard } from "@/lib/api-guard";
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

type RangeKey = "1h" | "1d" | "7d"
type ResolutionKey = "1m" | "5m" | "15m" | "1h"

type ServerMetricPoint = {
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

const RANGE_TO_MS: Record<RangeKey, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
}

const RESOLUTION_TO_MS: Record<ResolutionKey, number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
}

function safeQueryString(searchParams: URLSearchParams, key: string, max = 16) {
  const value = (searchParams.get(key) ?? "").trim()
  if (!value) return ""
  return value.slice(0, max)
}

function parseRange(raw: string): RangeKey {
  if (raw === "1h") return "1h"
  if (raw === "1d" || raw === "24h") return "1d"
  return "7d"
}

function parseResolution(raw: string): ResolutionKey {
  if (raw === "1m" || raw === "15m" || raw === "1h") return raw
  return "5m"
}

function toNumber(value: bigint | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null

  const asNumber = Number(value)
  return Number.isFinite(asNumber) ? asNumber : null
}

function toPoint(sample: {
  recordedAt: Date
  hostCpuPercent: number | null
  hostMemoryUsedBytes: bigint | null
  hostMemoryTotalBytes: bigint | null
  hostDiskUsedBytes: bigint | null
  hostDiskTotalBytes: bigint | null
  appCpuPercent: number | null
  appMemoryUsedBytes: bigint | null
  appMemoryLimitBytes: bigint | null
}): ServerMetricPoint {
  return {
    recordedAt: sample.recordedAt.toISOString(),
    hostCpuPercent: sample.hostCpuPercent,
    hostMemoryUsedBytes: toNumber(sample.hostMemoryUsedBytes),
    hostMemoryTotalBytes: toNumber(sample.hostMemoryTotalBytes),
    hostDiskUsedBytes: toNumber(sample.hostDiskUsedBytes),
    hostDiskTotalBytes: toNumber(sample.hostDiskTotalBytes),
    appCpuPercent: sample.appCpuPercent,
    appMemoryUsedBytes: toNumber(sample.appMemoryUsedBytes),
    appMemoryLimitBytes: toNumber(sample.appMemoryLimitBytes),
  }
}

type BucketAccumulator = {
  recordedAtMs: number
  hostCpuPercentSum: number
  hostCpuPercentCount: number
  hostMemoryUsedBytesSum: number
  hostMemoryUsedBytesCount: number
  hostMemoryTotalBytesSum: number
  hostMemoryTotalBytesCount: number
  hostDiskUsedBytesSum: number
  hostDiskUsedBytesCount: number
  hostDiskTotalBytesSum: number
  hostDiskTotalBytesCount: number
  appCpuPercentSum: number
  appCpuPercentCount: number
  appMemoryUsedBytesSum: number
  appMemoryUsedBytesCount: number
  appMemoryLimitBytesSum: number
  appMemoryLimitBytesCount: number
}

function avg(sum: number, count: number): number | null {
  if (count <= 0) return null
  return Number((sum / count).toFixed(2))
}

function avgRoundedBytes(sum: number, count: number): number | null {
  if (count <= 0) return null
  return Math.round(sum / count)
}

function downsampleSeries(points: ServerMetricPoint[], bucketMs: number): ServerMetricPoint[] {
  if (points.length === 0) return []
  if (bucketMs <= 60_000) return points

  const buckets = new Map<number, BucketAccumulator>()

  for (const point of points) {
    const atMs = new Date(point.recordedAt).getTime()
    if (!Number.isFinite(atMs)) continue

    const bucketAtMs = Math.floor(atMs / bucketMs) * bucketMs
    const current =
      buckets.get(bucketAtMs) ??
      ({
        recordedAtMs: bucketAtMs,
        hostCpuPercentSum: 0,
        hostCpuPercentCount: 0,
        hostMemoryUsedBytesSum: 0,
        hostMemoryUsedBytesCount: 0,
        hostMemoryTotalBytesSum: 0,
        hostMemoryTotalBytesCount: 0,
        hostDiskUsedBytesSum: 0,
        hostDiskUsedBytesCount: 0,
        hostDiskTotalBytesSum: 0,
        hostDiskTotalBytesCount: 0,
        appCpuPercentSum: 0,
        appCpuPercentCount: 0,
        appMemoryUsedBytesSum: 0,
        appMemoryUsedBytesCount: 0,
        appMemoryLimitBytesSum: 0,
        appMemoryLimitBytesCount: 0,
      } satisfies BucketAccumulator)

    if (point.hostCpuPercent !== null) {
      current.hostCpuPercentSum += point.hostCpuPercent
      current.hostCpuPercentCount += 1
    }
    if (point.hostMemoryUsedBytes !== null) {
      current.hostMemoryUsedBytesSum += point.hostMemoryUsedBytes
      current.hostMemoryUsedBytesCount += 1
    }
    if (point.hostMemoryTotalBytes !== null) {
      current.hostMemoryTotalBytesSum += point.hostMemoryTotalBytes
      current.hostMemoryTotalBytesCount += 1
    }
    if (point.hostDiskUsedBytes !== null) {
      current.hostDiskUsedBytesSum += point.hostDiskUsedBytes
      current.hostDiskUsedBytesCount += 1
    }
    if (point.hostDiskTotalBytes !== null) {
      current.hostDiskTotalBytesSum += point.hostDiskTotalBytes
      current.hostDiskTotalBytesCount += 1
    }
    if (point.appCpuPercent !== null) {
      current.appCpuPercentSum += point.appCpuPercent
      current.appCpuPercentCount += 1
    }
    if (point.appMemoryUsedBytes !== null) {
      current.appMemoryUsedBytesSum += point.appMemoryUsedBytes
      current.appMemoryUsedBytesCount += 1
    }
    if (point.appMemoryLimitBytes !== null) {
      current.appMemoryLimitBytesSum += point.appMemoryLimitBytes
      current.appMemoryLimitBytesCount += 1
    }

    buckets.set(bucketAtMs, current)
  }

  return [...buckets.values()]
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs)
    .map((bucket) => ({
      recordedAt: new Date(bucket.recordedAtMs).toISOString(),
      hostCpuPercent: avg(bucket.hostCpuPercentSum, bucket.hostCpuPercentCount),
      hostMemoryUsedBytes: avgRoundedBytes(
        bucket.hostMemoryUsedBytesSum,
        bucket.hostMemoryUsedBytesCount
      ),
      hostMemoryTotalBytes: avgRoundedBytes(
        bucket.hostMemoryTotalBytesSum,
        bucket.hostMemoryTotalBytesCount
      ),
      hostDiskUsedBytes: avgRoundedBytes(
        bucket.hostDiskUsedBytesSum,
        bucket.hostDiskUsedBytesCount
      ),
      hostDiskTotalBytes: avgRoundedBytes(
        bucket.hostDiskTotalBytesSum,
        bucket.hostDiskTotalBytesCount
      ),
      appCpuPercent: avg(bucket.appCpuPercentSum, bucket.appCpuPercentCount),
      appMemoryUsedBytes: avgRoundedBytes(
        bucket.appMemoryUsedBytesSum,
        bucket.appMemoryUsedBytesCount
      ),
      appMemoryLimitBytes: avgRoundedBytes(
        bucket.appMemoryLimitBytesSum,
        bucket.appMemoryLimitBytesCount
      ),
    }))
}

export async function GET(req: Request) {
  const _guard = communityGuard(); if (_guard) return _guard;
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { searchParams } = new URL(req.url)
  const range = parseRange(safeQueryString(searchParams, "range", 8))
  const resolution = parseResolution(safeQueryString(searchParams, "resolution", 8))

  const since = new Date(Date.now() - RANGE_TO_MS[range])
  const [latestRaw, rows] = await Promise.all([
    prisma.serverMetricSample.findFirst({
      orderBy: { recordedAt: "desc" },
      select: {
        recordedAt: true,
        hostCpuPercent: true,
        hostMemoryUsedBytes: true,
        hostMemoryTotalBytes: true,
        hostDiskUsedBytes: true,
        hostDiskTotalBytes: true,
        appCpuPercent: true,
        appMemoryUsedBytes: true,
        appMemoryLimitBytes: true,
      },
    }),
    prisma.serverMetricSample.findMany({
      where: { recordedAt: { gte: since } },
      orderBy: { recordedAt: "asc" },
      select: {
        recordedAt: true,
        hostCpuPercent: true,
        hostMemoryUsedBytes: true,
        hostMemoryTotalBytes: true,
        hostDiskUsedBytes: true,
        hostDiskTotalBytes: true,
        appCpuPercent: true,
        appMemoryUsedBytes: true,
        appMemoryLimitBytes: true,
      },
    }),
  ])

  const points = rows.map(toPoint)
  const series = downsampleSeries(points, RESOLUTION_TO_MS[resolution])

  return NextResponse.json({
    range,
    resolution,
    latest: latestRaw ? toPoint(latestRaw) : null,
    series,
    sampleCount: rows.length,
    generatedAt: new Date().toISOString(),
  })
}
