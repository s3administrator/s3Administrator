import { prisma } from "@/lib/db"
import { isCommunityEdition } from "@/lib/edition"
import type { Prisma } from "@prisma/client"

type AuditLogInput = {
  userId: string
  eventType: string
  eventName: string
  path: string
  method?: string
  target?: string
  metadata?: Prisma.InputJsonValue
  ipAddress?: string | null
  userAgent?: string | null
}

function safeString(value: string | null | undefined, max: number) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

export function getRequestContext(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")
  const ipAddress = forwardedFor
    ? forwardedFor.split(",")[0]?.trim()?.slice(0, 64) ?? null
    : request.headers.get("x-real-ip")?.slice(0, 64) ?? null

  const userAgent = request.headers.get("user-agent")?.slice(0, 512) ?? null

  return { ipAddress, userAgent }
}

export async function logUserAuditAction(input: AuditLogInput) {
  if (isCommunityEdition()) return

  try {
    await prisma.userActionEvent.create({
      data: {
        userId: input.userId,
        eventType: safeString(input.eventType, 64) ?? "unknown",
        eventName: safeString(input.eventName, 120) ?? "unknown",
        path: safeString(input.path, 512) ?? "/",
        method: safeString(input.method, 16),
        target: safeString(input.target, 512),
        metadata: input.metadata,
        ipAddress: safeString(input.ipAddress, 64),
        userAgent: safeString(input.userAgent, 512),
      },
    })
  } catch {
    // Audit logging must never block user operations.
  }
}

