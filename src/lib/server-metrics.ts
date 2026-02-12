import { promises as fs } from "fs"
import os from "os"
import { prisma } from "@/lib/db"
import { logSystemEvent } from "@/lib/system-logger"

type PrometheusSample = {
  labels: Record<string, string>
  value: number
}

type CpuCounterSnapshot = {
  total: number
  idle: number
  atMs: number
}

type AppCpuSnapshot = {
  usageNs: bigint
  atMs: number
}

type HostMetricValues = {
  hostCpuPercent: number | null
  hostMemoryUsedBytes: bigint | null
  hostMemoryTotalBytes: bigint | null
  hostDiskUsedBytes: bigint | null
  hostDiskTotalBytes: bigint | null
}

type AppMetricValues = {
  appCpuPercent: number | null
  appMemoryUsedBytes: bigint | null
  appMemoryLimitBytes: bigint | null
}

const DEFAULT_NODE_EXPORTER_URL = "http://node-exporter:9100/metrics"
const DEFAULT_INTERVAL_SECONDS = 60
const DEFAULT_RETENTION_DAYS = 7
const FETCH_TIMEOUT_MS = 5000
const ISSUE_LOG_THROTTLE_MS = 15 * 60 * 1000

const PSEUDO_FILESYSTEM_TYPES = new Set([
  "autofs",
  "binfmt_misc",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "overlay",
  "proc",
  "pstore",
  "rpc_pipefs",
  "securityfs",
  "selinuxfs",
  "squashfs",
  "sysfs",
  "tmpfs",
  "tracefs",
])

const globalForServerMetrics = globalThis as unknown as {
  __serverMetricsStarted?: boolean
  __serverMetricsTimer?: ReturnType<typeof setInterval>
  __serverMetricsRunning?: boolean
  __serverMetricsHostCpuPrev?: CpuCounterSnapshot
  __serverMetricsAppCpuPrev?: AppCpuSnapshot
  __serverMetricsIssueLogAt?: Record<string, number>
}

function parseIntegerEnv(
  value: string | undefined,
  fallback: number,
  opts?: { min?: number; max?: number }
) {
  const parsed = Number.parseInt(value ?? "", 10)
  if (!Number.isFinite(parsed)) return fallback
  if (opts?.min !== undefined && parsed < opts.min) return opts.min
  if (opts?.max !== undefined && parsed > opts.max) return opts.max
  return parsed
}

function envFlagEnabled(value: string | undefined, fallback = true) {
  if (!value) return fallback
  return value.toLowerCase() !== "false"
}

function normalizePercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Number(Math.max(0, Math.min(100, value)).toFixed(2))
}

function toBigIntBytes(value: number | null): bigint | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null
  return BigInt(Math.round(value))
}

function floorToUtcMinute(date: Date) {
  const next = new Date(date)
  next.setUTCSeconds(0, 0)
  return next
}

function parsePrometheusLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {}
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(raw)) !== null) {
    labels[match[1]] = match[2]
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\")
      .replaceAll("\\n", "\n")
  }

  return labels
}

function parsePrometheusSamples(text: string, metricName: string): PrometheusSample[] {
  const samples: PrometheusSample[] = []
  const lines = text.split("\n")
  const pattern = new RegExp(
    `^${metricName}(?:\\{([^}]*)\\})?\\s+([-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?)$`
  )

  for (const line of lines) {
    if (!line || line[0] === "#") continue
    if (!line.startsWith(metricName)) continue

    const match = line.match(pattern)
    if (!match) continue

    const value = Number.parseFloat(match[2])
    if (!Number.isFinite(value)) continue

    samples.push({
      labels: parsePrometheusLabels(match[1] ?? ""),
      value,
    })
  }

  return samples
}

function findMetricValue(text: string, metricName: string): number | null {
  const sample = parsePrometheusSamples(text, metricName)[0]
  if (!sample) return null
  return sample.value
}

function deriveHostCpuPercent(rawMetrics: string): number | null {
  const samples = parsePrometheusSamples(rawMetrics, "node_cpu_seconds_total")
  if (samples.length === 0) return null

  let total = 0
  let idle = 0
  for (const sample of samples) {
    total += sample.value
    const mode = sample.labels.mode
    if (mode === "idle" || mode === "iowait") {
      idle += sample.value
    }
  }

  if (!Number.isFinite(total) || total <= 0) return null
  if (!Number.isFinite(idle) || idle < 0) return null

  const nowMs = Date.now()
  const prev = globalForServerMetrics.__serverMetricsHostCpuPrev
  globalForServerMetrics.__serverMetricsHostCpuPrev = { total, idle, atMs: nowMs }

  if (!prev) return null
  if (total <= prev.total || idle < prev.idle) return null
  if (nowMs <= prev.atMs) return null

  const totalDelta = total - prev.total
  const idleDelta = idle - prev.idle
  if (totalDelta <= 0) return null

  return normalizePercent((1 - idleDelta / totalDelta) * 100)
}

function chooseRootFilesystemSample(samples: PrometheusSample[]) {
  const filtered = samples.filter((sample) => {
    const fstype = sample.labels.fstype ?? ""
    return !PSEUDO_FILESYSTEM_TYPES.has(fstype)
  })

  const rootOnly = filtered.filter(
    (sample) => (sample.labels.mountpoint ?? "") === "/"
  )
  const pool = rootOnly.length > 0 ? rootOnly : filtered
  if (pool.length === 0) return null

  return pool.reduce((best, sample) => (sample.value > best.value ? sample : best), pool[0])
}

function deriveHostDisk(rawMetrics: string) {
  const sizeSamples = parsePrometheusSamples(rawMetrics, "node_filesystem_size_bytes")
  const availSamples = parsePrometheusSamples(rawMetrics, "node_filesystem_avail_bytes")

  const chosenSize = chooseRootFilesystemSample(sizeSamples)
  if (!chosenSize) return { totalBytes: null as bigint | null, usedBytes: null as bigint | null }

  const sameFsAvail =
    availSamples.find((sample) => {
      return (
        sample.labels.mountpoint === chosenSize.labels.mountpoint &&
        sample.labels.device === chosenSize.labels.device &&
        sample.labels.fstype === chosenSize.labels.fstype
      )
    }) ??
    availSamples.find((sample) => sample.labels.mountpoint === chosenSize.labels.mountpoint)

  if (!sameFsAvail) {
    return {
      totalBytes: toBigIntBytes(chosenSize.value),
      usedBytes: null,
    }
  }

  const total = chosenSize.value
  const avail = sameFsAvail.value
  if (!Number.isFinite(total) || !Number.isFinite(avail) || total <= 0) {
    return { totalBytes: null as bigint | null, usedBytes: null as bigint | null }
  }

  const used = Math.max(0, total - avail)
  return {
    totalBytes: toBigIntBytes(total),
    usedBytes: toBigIntBytes(used),
  }
}

function deriveHostMemory(rawMetrics: string) {
  const total = findMetricValue(rawMetrics, "node_memory_MemTotal_bytes")
  const available = findMetricValue(rawMetrics, "node_memory_MemAvailable_bytes")

  if (total === null || available === null || total <= 0) {
    return {
      totalBytes: null as bigint | null,
      usedBytes: null as bigint | null,
    }
  }

  const used = Math.max(0, total - available)
  return {
    totalBytes: toBigIntBytes(total),
    usedBytes: toBigIntBytes(used),
  }
}

async function readFirstAvailableFile(paths: string[]) {
  for (const filePath of paths) {
    try {
      const value = await fs.readFile(filePath, "utf8")
      return value.trim()
    } catch {
      // Try next path.
    }
  }
  return null
}

function parseBigIntValue(raw: string | null) {
  if (!raw || !/^\d+$/.test(raw)) return null
  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

async function readAppMemory() {
  const usedRaw = await readFirstAvailableFile([
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ])
  const limitRaw = await readFirstAvailableFile([
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ])

  const hasCgroupData = usedRaw !== null || limitRaw !== null
  let used = parseBigIntValue(usedRaw)
  let limit: bigint | null = null
  if (limitRaw === "max") {
    limit = null
  } else {
    limit = parseBigIntValue(limitRaw)
  }

  if (limit !== null && limit > BigInt("1000000000000000")) {
    limit = null
  }

  if (!hasCgroupData) {
    const rss = process.memoryUsage().rss
    if (Number.isFinite(rss) && rss > 0) {
      used = BigInt(Math.round(rss))
    }

    const total = os.totalmem()
    if (Number.isFinite(total) && total > 0) {
      limit = BigInt(Math.round(total))
    }
  }

  return {
    usedBytes: used,
    limitBytes: limit,
  }
}

async function readAppCpuUsageNs() {
  const cpuStatRaw = await readFirstAvailableFile(["/sys/fs/cgroup/cpu.stat"])
  if (cpuStatRaw) {
    const usageMatch = cpuStatRaw.match(/^usage_usec\s+(\d+)$/m)
    if (usageMatch) {
      const usageUsec = parseBigIntValue(usageMatch[1])
      if (usageUsec !== null) {
        return usageUsec * BigInt(1000)
      }
    }
  }

  const cpuacctRaw = await readFirstAvailableFile(["/sys/fs/cgroup/cpuacct/cpuacct.usage"])
  return parseBigIntValue(cpuacctRaw)
}

function deriveAppCpuPercent(usageNs: bigint | null): number | null {
  if (usageNs === null) return null

  const nowMs = Date.now()
  const prev = globalForServerMetrics.__serverMetricsAppCpuPrev
  globalForServerMetrics.__serverMetricsAppCpuPrev = {
    usageNs,
    atMs: nowMs,
  }

  if (!prev) return null
  if (usageNs < prev.usageNs || nowMs <= prev.atMs) return null

  const usageDeltaNs = usageNs - prev.usageNs
  const elapsedNs = BigInt(nowMs - prev.atMs) * BigInt(1_000_000)
  if (elapsedNs <= BigInt(0)) return null

  const percent = Number(usageDeltaNs) / Number(elapsedNs) * 100
  return normalizePercent(percent)
}

function shouldLogIssueNow(issueKey: string) {
  const nowMs = Date.now()
  const issueMap = globalForServerMetrics.__serverMetricsIssueLogAt ?? {}
  const lastLoggedAt = issueMap[issueKey] ?? 0

  if (nowMs - lastLoggedAt < ISSUE_LOG_THROTTLE_MS) {
    return false
  }

  issueMap[issueKey] = nowMs
  globalForServerMetrics.__serverMetricsIssueLogAt = issueMap
  return true
}

function logCollectorIssue(issueKey: string, message: string, metadata?: Record<string, unknown>) {
  if (!shouldLogIssueNow(issueKey)) return

  void logSystemEvent({
    source: "app",
    level: "warn",
    message,
    route: "/admin/server",
    metadata: {
      channel: "server-metrics-collector",
      ...metadata,
    },
  })
}

async function fetchHostMetrics() {
  const nodeExporterUrl =
    process.env.SERVER_METRICS_NODE_EXPORTER_URL?.trim() || DEFAULT_NODE_EXPORTER_URL

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(nodeExporterUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "text/plain",
      },
    })

    if (!response.ok) {
      logCollectorIssue("host_metrics_http", "server_metrics_host_fetch_failed", {
        nodeExporterUrl,
        status: response.status,
      })
      return null
    }

    return await response.text()
  } catch (error) {
    logCollectorIssue("host_metrics_network", "server_metrics_host_fetch_failed", {
      nodeExporterUrl,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function collectHostMetricValues(): Promise<HostMetricValues> {
  const raw = await fetchHostMetrics()
  if (!raw) {
    return {
      hostCpuPercent: null,
      hostMemoryUsedBytes: null,
      hostMemoryTotalBytes: null,
      hostDiskUsedBytes: null,
      hostDiskTotalBytes: null,
    }
  }

  const hostCpuPercent = deriveHostCpuPercent(raw)
  const hostMemory = deriveHostMemory(raw)
  const hostDisk = deriveHostDisk(raw)

  return {
    hostCpuPercent,
    hostMemoryUsedBytes: hostMemory.usedBytes,
    hostMemoryTotalBytes: hostMemory.totalBytes,
    hostDiskUsedBytes: hostDisk.usedBytes,
    hostDiskTotalBytes: hostDisk.totalBytes,
  }
}

async function collectAppMetricValues(): Promise<AppMetricValues> {
  const [usageNs, appMemory] = await Promise.all([readAppCpuUsageNs(), readAppMemory()])
  const appCpuPercent = deriveAppCpuPercent(usageNs)

  return {
    appCpuPercent,
    appMemoryUsedBytes: appMemory.usedBytes,
    appMemoryLimitBytes: appMemory.limitBytes,
  }
}

async function collectAndPersistServerMetrics() {
  if (globalForServerMetrics.__serverMetricsRunning) return
  globalForServerMetrics.__serverMetricsRunning = true

  const retentionDays = parseIntegerEnv(
    process.env.SERVER_METRICS_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
    { min: 1, max: 30 }
  )

  try {
    const [hostValues, appValues] = await Promise.all([
      collectHostMetricValues(),
      collectAppMetricValues(),
    ])

    const recordedAt = floorToUtcMinute(new Date())
    await prisma.serverMetricSample.upsert({
      where: { recordedAt },
      create: {
        recordedAt,
        hostCpuPercent: hostValues.hostCpuPercent,
        hostMemoryUsedBytes: hostValues.hostMemoryUsedBytes,
        hostMemoryTotalBytes: hostValues.hostMemoryTotalBytes,
        hostDiskUsedBytes: hostValues.hostDiskUsedBytes,
        hostDiskTotalBytes: hostValues.hostDiskTotalBytes,
        appCpuPercent: appValues.appCpuPercent,
        appMemoryUsedBytes: appValues.appMemoryUsedBytes,
        appMemoryLimitBytes: appValues.appMemoryLimitBytes,
      },
      update: {
        hostCpuPercent: hostValues.hostCpuPercent,
        hostMemoryUsedBytes: hostValues.hostMemoryUsedBytes,
        hostMemoryTotalBytes: hostValues.hostMemoryTotalBytes,
        hostDiskUsedBytes: hostValues.hostDiskUsedBytes,
        hostDiskTotalBytes: hostValues.hostDiskTotalBytes,
        appCpuPercent: appValues.appCpuPercent,
        appMemoryUsedBytes: appValues.appMemoryUsedBytes,
        appMemoryLimitBytes: appValues.appMemoryLimitBytes,
      },
    })

    const retentionCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    await prisma.serverMetricSample.deleteMany({
      where: {
        recordedAt: {
          lt: retentionCutoff,
        },
      },
    })
  } catch (error) {
    logCollectorIssue("collect_persist", "server_metrics_collection_failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    globalForServerMetrics.__serverMetricsRunning = false
  }
}

export function startServerMetricsCollector() {
  if (typeof window !== "undefined") return

  const enabled = envFlagEnabled(process.env.SERVER_METRICS_ENABLED, true)
  if (!enabled) return

  if (globalForServerMetrics.__serverMetricsStarted) return
  globalForServerMetrics.__serverMetricsStarted = true

  const intervalSeconds = parseIntegerEnv(
    process.env.SERVER_METRICS_INTERVAL_SECONDS,
    DEFAULT_INTERVAL_SECONDS,
    { min: 10, max: 3600 }
  )
  const intervalMs = intervalSeconds * 1000

  void collectAndPersistServerMetrics()

  globalForServerMetrics.__serverMetricsTimer = setInterval(() => {
    void collectAndPersistServerMetrics()
  }, intervalMs)

  if (
    globalForServerMetrics.__serverMetricsTimer &&
    typeof globalForServerMetrics.__serverMetricsTimer === "object" &&
    "unref" in globalForServerMetrics.__serverMetricsTimer
  ) {
    globalForServerMetrics.__serverMetricsTimer.unref()
  }
}
