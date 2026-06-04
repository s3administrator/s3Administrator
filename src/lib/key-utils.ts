export function extractFilename(key: string): string {
  const normalized = key.endsWith("/") ? key.slice(0, -1) : key
  return normalized.split("/").pop() || "download"
}

export function toContentDispositionFilename(filename: string): string {
  return filename.replace(/["\\]/g, "_")
}
