import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import type { Prisma } from "@prisma/client"

type IncomingEvent = {
  eventType?: unknown
  eventName?: unknown
  path?: unknown
  method?: unknown
  target?: unknown
  metadata?: unknown
}

function safeString(value: unknown, max = 255): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function jsonMetadata(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (Array.isArray(value) || typeof value === "object") {
    return value as Prisma.InputJsonValue
  }
  return undefined
}

function getIpAddress(req: Request): string | null {
  const forwardedFor = req.headers.get("x-forwarded-for")
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim()
    if (first) return first.slice(0, 64)
  }

  const realIp = req.headers.get("x-real-ip")
  if (realIp) return realIp.slice(0, 64)

  return null
}

export async function POST(req: Request) {
  const session = await auth()

  const body = await req.json().catch(() => null)
  const rawEvents: IncomingEvent[] = Array.isArray(body?.events) ? body.events : []

  if (rawEvents.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0 })
  }

  const cappedEvents = rawEvents.slice(0, 50)
  const ipAddress = getIpAddress(req)
  const userAgent = req.headers.get("user-agent")?.slice(0, 512) ?? null

  const data = cappedEvents
    .map((event) => {
      const eventType = safeString(event.eventType, 64)
      const eventName = safeString(event.eventName, 120)
      const path = safeString(event.path, 512)

      if (!eventType || !eventName || !path) return null

      return {
        userId: session?.user?.id ?? null,
        eventType,
        eventName,
        path,
        method: safeString(event.method, 16),
        target: safeString(event.target, 512),
        metadata: jsonMetadata(event.metadata),
        ipAddress,
        userAgent,
      }
    })
    .filter((event): event is NonNullable<typeof event> => Boolean(event))

  if (data.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0 })
  }

  try {
    await prisma.userActionEvent.createMany({ data })
  } catch {
    return NextResponse.json({ ok: false }, { status: 202 })
  }

  return NextResponse.json({ ok: true, inserted: data.length })
}
