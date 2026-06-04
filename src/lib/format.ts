const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"]

export function formatSize(bytes: number, zeroLabel = "0 B"): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return zeroLabel
  const i = Math.min(
    SIZE_UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  )
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${SIZE_UNITS[i]}`
}

export function formatDate(
  value: string | null | undefined,
  fallback = "—",
): string {
  if (!value) return fallback
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return ""
  return `${formatSize(bytesPerSec)}/s`
}

export function formatEta(bytesRemaining: number, speed: number): string {
  if (speed <= 0) return ""
  const seconds = Math.ceil(bytesRemaining / speed)
  if (seconds < 60) return `${seconds}s left`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m left`
  return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m left`
}
