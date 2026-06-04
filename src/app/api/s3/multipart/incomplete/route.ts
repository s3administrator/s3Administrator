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
  scanIncompleteMultipart,
  scanIncompleteMultipartPage,
} from "@/lib/s3-multipart-incomplete"

function toQueryPayload(request: NextRequest) {
  return {
    bucket: request.nextUrl.searchParams.get("bucket") ?? undefined,
    credentialId: request.nextUrl.searchParams.get("credentialId") ?? undefined,
  }
}

function parseDetailsFlag(request: NextRequest): {
  ok: true
  details: boolean
} | {
  ok: false
} {
  const raw = request.nextUrl.searchParams.get("details")
  if (raw === null) {
    return { ok: true, details: false }
  }
  if (raw === "true") {
    return { ok: true, details: true }
  }
  if (raw === "false") {
    return { ok: true, details: false }
  }
  return { ok: false }
}

function parseBooleanParam(
  raw: string | null,
  defaultValue: boolean
): {
  ok: true
  value: boolean
} | {
  ok: false
} {
  if (raw === null) {
    return { ok: true, value: defaultValue }
  }
  if (raw === "true") {
    return { ok: true, value: true }
  }
  if (raw === "false") {
    return { ok: true, value: false }
  }
  return { ok: false }
}

function parseLimitParam(raw: string | null): {
  ok: true
  limit: number
} | {
  ok: false
} {
  if (raw === null || raw.trim().length === 0) {
    return { ok: true, limit: 50 }
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    return { ok: false }
  }
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

    const limitResult = rateLimitByUser(
      session.user.id,
      "s3-multipart-incomplete-read",
      120,
      60_000
    )
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const detailsParse = parseDetailsFlag(request)
    if (!detailsParse.ok) {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 })
    }
    details = detailsParse.details

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

    const parsed = bucketManageSchema.safeParse(toQueryPayload(request))
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
      const uploadIdMarker = request.nextUrl.searchParams.get("uploadIdMarker") ?? undefined

      const pageScan = await scanIncompleteMultipartPage(client, bucket, {
        limit,
        keyMarker,
        uploadIdMarker,
      })

      const summary = includeSummary
        ? (await scanIncompleteMultipart(client, bucket, false)).summary
        : null

      await logUserAuditAction({
        userId: session.user.id,
        eventType: "s3_action",
        eventName: "multipart_incomplete_list",
        path: "/api/s3/multipart/incomplete",
        method: "GET",
        target: bucket,
        metadata: {
          bucket,
          credentialId: credential.id,
          details,
          includeSummary,
          limit,
          keyMarker: keyMarker ?? null,
          uploadIdMarker: uploadIdMarker ?? null,
          uploads: pageScan.pageSummary.uploads,
          parts: pageScan.pageSummary.parts,
          incompleteSize: pageScan.pageSummary.incompleteSize,
          hasMore: pageScan.hasMore,
        },
        ...requestContext,
      })

      return NextResponse.json({
        bucket,
        credentialId: credential.id,
        summary,
        uploads: pageScan.uploads,
        pagination: {
          hasMore: pageScan.hasMore,
          limit,
          nextKeyMarker: pageScan.nextKeyMarker,
          nextUploadIdMarker: pageScan.nextUploadIdMarker,
        },
      })
    }

    const scan = await scanIncompleteMultipart(client, bucket, false)

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "multipart_incomplete_list",
      path: "/api/s3/multipart/incomplete",
      method: "GET",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        details,
        uploads: scan.summary.uploads,
        parts: scan.summary.parts,
        incompleteSize: scan.summary.incompleteSize,
      },
      ...requestContext,
    })

    return NextResponse.json({
      bucket,
      credentialId: credential.id,
      summary: scan.summary,
      uploads: [],
    })
  } catch (error) {
    console.error("Failed to list incomplete multipart uploads:", error)

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "multipart_incomplete_list_failed",
        path: "/api/s3/multipart/incomplete",
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
      { error: "Failed to list incomplete multipart uploads" },
      { status: 500 }
    )
  }
}
