import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { bucketManageSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import {
  getS3ErrorCode,
  getS3ErrorMessage,
  isPermissionStyleS3Error,
  scanNoncurrentVersions,
  scanNoncurrentVersionsPage,
} from "@/lib/s3-object-versions"

function parseBooleanParam(
  raw: string | null,
  defaultValue: boolean
): { ok: true; value: boolean } | { ok: false } {
  if (raw === null) return { ok: true, value: defaultValue }
  if (raw === "true") return { ok: true, value: true }
  if (raw === "false") return { ok: true, value: false }
  return { ok: false }
}

function parseLimitParam(
  raw: string | null
): { ok: true; limit: number } | { ok: false } {
  if (raw === null || raw.trim().length === 0) return { ok: true, limit: 50 }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return { ok: false }
  return { ok: true, limit: parsed }
}

export async function GET(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditCredentialId = ""
  let details = false
  let includeSummary = false
  let limit = 50
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-versions-read", 120, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const detailsParse = parseBooleanParam(
      request.nextUrl.searchParams.get("details"),
      false
    )
    if (!detailsParse.ok) {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 })
    }
    details = detailsParse.value

    const includeSummaryParse = parseBooleanParam(
      request.nextUrl.searchParams.get("includeSummary"),
      false
    )
    if (!includeSummaryParse.ok) {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 })
    }
    includeSummary = includeSummaryParse.value

    const limitParse = parseLimitParam(request.nextUrl.searchParams.get("limit"))
    if (!limitParse.ok) {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 })
    }
    limit = limitParse.limit

    const parsed = bucketManageSchema.safeParse({
      bucket: request.nextUrl.searchParams.get("bucket") ?? undefined,
      credentialId: request.nextUrl.searchParams.get("credentialId") ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId } = parsed.data
    auditBucket = bucket

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    auditCredentialId = credential.id

    if (details) {
      const keyMarker = request.nextUrl.searchParams.get("keyMarker") ?? undefined
      const versionIdMarker = request.nextUrl.searchParams.get("versionIdMarker") ?? undefined

      const pageScan = await scanNoncurrentVersionsPage(client, bucket, {
        limit,
        keyMarker,
        versionIdMarker,
      })

      const summary = includeSummary
        ? (await scanNoncurrentVersions(client, bucket, false)).summary
        : null

      await logUserAuditAction({
        userId: session.user.id,
        eventType: "s3_action",
        eventName: "versions_noncurrent_list",
        path: "/api/s3/versions",
        method: "GET",
        target: bucket,
        metadata: {
          bucket,
          credentialId: credential.id,
          details,
          includeSummary,
          limit,
          noncurrentVersions: pageScan.pageSummary.noncurrentVersions,
          deleteMarkers: pageScan.pageSummary.deleteMarkers,
          noncurrentSize: pageScan.pageSummary.noncurrentSize,
          hasMore: pageScan.hasMore,
        },
        ...requestContext,
      })

      return NextResponse.json({
        bucket,
        credentialId: credential.id,
        summary,
        versions: pageScan.versions,
        pagination: {
          hasMore: pageScan.hasMore,
          limit,
          nextKeyMarker: pageScan.nextKeyMarker,
          nextVersionIdMarker: pageScan.nextVersionIdMarker,
        },
      })
    }

    const scan = await scanNoncurrentVersions(client, bucket, false)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "versions_noncurrent_list",
      path: "/api/s3/versions",
      method: "GET",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        details,
        noncurrentVersions: scan.summary.noncurrentVersions,
        deleteMarkers: scan.summary.deleteMarkers,
        noncurrentSize: scan.summary.noncurrentSize,
      },
      ...requestContext,
    })

    return NextResponse.json({
      bucket,
      credentialId: credential.id,
      summary: scan.summary,
      versions: [],
    })
  } catch (error) {
    console.error("Failed to scan non-current versions:", error)

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "versions_noncurrent_list_failed",
        path: "/api/s3/versions",
        method: "GET",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          credentialId: auditCredentialId || null,
          details,
          includeSummary,
          limit,
          error: getS3ErrorMessage(error),
          code: getS3ErrorCode(error) || null,
        },
        ...requestContext,
      })
    }

    if (isPermissionStyleS3Error(error)) {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 })
    }

    return NextResponse.json(
      { error: "Failed to scan non-current versions" },
      { status: 500 }
    )
  }
}
