import type { NextRequest } from "next/server"

export type AuditRequestContext = {
  ipAddress?: string | null
  userAgent?: string | null
}

export function getRequestContext(_request: NextRequest): AuditRequestContext {
  return { ipAddress: null, userAgent: null }
}

export async function logUserAuditAction(_event: unknown): Promise<void> {
  // Desktop single-user build: audit logging is intentionally a no-op.
}
