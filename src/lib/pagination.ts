export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url")
}

export function decodeCursor(raw: string): { offset: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (typeof parsed.offset !== "number" || !Number.isFinite(parsed.offset) || parsed.offset < 0) return null
    return { offset: Math.floor(parsed.offset) }
  } catch {
    return null
  }
}
