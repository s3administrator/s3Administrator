import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { bucketManageSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import {
  getS3ErrorMessage,
  isPermissionStyleS3Error,
  listVersionsForPrefix,
} from "@/lib/s3-object-versions"

function parseLimitParam(
  raw: string | null
): { ok: true; limit: number } | { ok: false } {
  if (raw === null || raw.trim().length === 0) return { ok: true, limit: 500 }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) return { ok: false }
  return { ok: true, limit: parsed }
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const limitResult = rateLimitByUser(session.user.id, "s3-versions-list", 120, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

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

    const limitParse = parseLimitParam(request.nextUrl.searchParams.get("limit"))
    if (!limitParse.ok) {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 })
    }

    const { bucket, credentialId } = parsed.data
    const prefix = request.nextUrl.searchParams.get("prefix") ?? undefined
    const keyMarker = request.nextUrl.searchParams.get("keyMarker") ?? undefined
    const versionIdMarker = request.nextUrl.searchParams.get("versionIdMarker") ?? undefined

    const { client } = await getS3Client(session.user.id, credentialId)

    const result = await listVersionsForPrefix(client, bucket, {
      prefix,
      limit: limitParse.limit,
      keyMarker,
      versionIdMarker,
    })

    return NextResponse.json({
      bucket,
      versions: result.versions,
      pagination: {
        hasMore: result.hasMore,
        nextKeyMarker: result.nextKeyMarker,
        nextVersionIdMarker: result.nextVersionIdMarker,
      },
    })
  } catch (error) {
    console.error("Failed to list object versions:", error)

    if (isPermissionStyleS3Error(error)) {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 })
    }

    return NextResponse.json(
      { error: getS3ErrorMessage(error) || "Failed to list object versions" },
      { status: 500 }
    )
  }
}
