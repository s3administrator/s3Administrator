const DEFAULT_TRANSFER_MTIME_TOLERANCE_MS = 1_000

type TransferSizeValue = bigint | number | string

interface TransferComparableObject {
  size: TransferSizeValue
  lastModified: Date
}

function toComparableBigInt(value: TransferSizeValue): bigint | null {
  if (typeof value === "bigint") {
    return value >= BigInt(0) ? value : null
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null
    const floored = Math.floor(value)
    if (!Number.isSafeInteger(floored)) return null
    return BigInt(floored)
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      const parsed = BigInt(trimmed)
      return parsed >= BigInt(0) ? parsed : null
    } catch {
      return null
    }
  }

  return null
}

function toComparableTimeMs(value: Date): number | null {
  if (!(value instanceof Date)) return null
  const ms = value.getTime()
  return Number.isFinite(ms) ? ms : null
}

export function areTransferObjectsEquivalent(
  source: TransferComparableObject,
  destination: TransferComparableObject,
  options?: {
    mtimeToleranceMs?: number
  }
): boolean {
  const sourceSize = toComparableBigInt(source.size)
  const destinationSize = toComparableBigInt(destination.size)
  if (sourceSize === null || destinationSize === null) return false
  if (sourceSize !== destinationSize) return false

  const sourceMtimeMs = toComparableTimeMs(source.lastModified)
  const destinationMtimeMs = toComparableTimeMs(destination.lastModified)
  if (sourceMtimeMs === null || destinationMtimeMs === null) return false

  const tolerance = Math.max(
    0,
    Math.floor(options?.mtimeToleranceMs ?? DEFAULT_TRANSFER_MTIME_TOLERANCE_MS)
  )
  return Math.abs(sourceMtimeMs - destinationMtimeMs) <= tolerance
}

export function isDestinationUpToDateForSync(
  source: TransferComparableObject,
  destination: TransferComparableObject,
  options?: {
    mtimeToleranceMs?: number
  }
): boolean {
  const sourceSize = toComparableBigInt(source.size)
  const destinationSize = toComparableBigInt(destination.size)
  if (sourceSize === null || destinationSize === null) return false
  if (sourceSize !== destinationSize) return false

  const sourceMtimeMs = toComparableTimeMs(source.lastModified)
  const destinationMtimeMs = toComparableTimeMs(destination.lastModified)
  if (sourceMtimeMs === null || destinationMtimeMs === null) return false

  const tolerance = Math.max(
    0,
    Math.floor(options?.mtimeToleranceMs ?? DEFAULT_TRANSFER_MTIME_TOLERANCE_MS)
  )

  // Treat destination as current when it is at least as new as source,
  // accounting for provider precision drift.
  return destinationMtimeMs + tolerance >= sourceMtimeMs
}
