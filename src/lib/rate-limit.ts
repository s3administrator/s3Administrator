import { NextResponse } from "next/server"

type RateLimitEntry = {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

// Cleanup expired entries every 60 seconds
const CLEANUP_INTERVAL_MS = 60_000
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function ensureCleanup() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key)
      }
    }
  }, CLEANUP_INTERVAL_MS)
  // Allow Node.js to exit even if timer is running
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref()
  }
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { success: boolean; remaining: number; retryAfterSeconds: number } {
  ensureCleanup()

  const now = Date.now()
  const entry = store.get(key)

  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { success: true, remaining: limit - 1, retryAfterSeconds: 0 }
  }

  if (entry.count < limit) {
    entry.count++
    return { success: true, remaining: limit - entry.count, retryAfterSeconds: 0 }
  }

  const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000)
  return { success: false, remaining: 0, retryAfterSeconds }
}

function getIpFromRequest(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  const realIp = req.headers.get("x-real-ip")
  if (realIp) return realIp
  return "unknown"
}

export function rateLimitByIp(
  req: Request,
  prefix: string,
  limit: number,
  windowMs: number = 60_000
): { success: boolean; remaining: number; retryAfterSeconds: number } {
  const ip = getIpFromRequest(req)
  return rateLimit(`${prefix}:${ip}`, limit, windowMs)
}

export function rateLimitByUser(
  userId: string,
  prefix: string,
  limit: number,
  windowMs: number = 60_000
): { success: boolean; remaining: number; retryAfterSeconds: number } {
  return rateLimit(`${prefix}:${userId}`, limit, windowMs)
}

export function rateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: "Too many requests. Please try again later." },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    }
  )
}
