import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import {
  buildFileSearchOrderBySql,
  buildFileSearchSqlWhereClause,
  normalizeFileSearchSortBy,
  normalizeFileSearchSortDir,
  parseCsvValues,
  parseScopes,
} from "@/lib/file-search"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

interface SearchResultRow {
  id: string
  key: string
  bucket: string
  credentialId: string
  size: bigint
  lastModified: Date
}

interface CountRow {
  total: bigint
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const rl = rateLimitByUser(session.user.id, "s3-search", 60)
    if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

    const entitlements = await getUserPlanEntitlements(session.user.id)
    if (!entitlements?.searchAllFiles) {
      return NextResponse.json(
        {
          error: "Search all files is disabled for the current plan",
          details: {
            plan: entitlements?.slug ?? "free",
            planSource: entitlements?.source ?? "default",
          },
        },
        { status: 403 }
      )
    }

    const { searchParams } = request.nextUrl
    const query = searchParams.get("q") || ""
    const bucketsParam = searchParams.get("buckets") || ""
    const credentialIdsParam = searchParams.get("credentialIds") || ""
    const scopeParams = searchParams.getAll("scope")
    const type = searchParams.get("type") || ""
    const sortBy = normalizeFileSearchSortBy(searchParams.get("sortBy"))
    const sortDir = normalizeFileSearchSortDir(searchParams.get("sortDir"))
    const skipRaw = Number(searchParams.get("skip") || "0")
    const takeRaw = Number(searchParams.get("take") || "100")
    const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? Math.floor(skipRaw) : 0
    const take = Number.isFinite(takeRaw) ? Math.min(100, Math.max(1, Math.floor(takeRaw))) : 100

    if (query.trim().length < 2) {
      return NextResponse.json({ results: [], total: 0 })
    }

    const buckets = parseCsvValues(bucketsParam)
    const credentialIds = parseCsvValues(credentialIdsParam)
    const scopes = parseScopes(scopeParams)

    const whereClause = buildFileSearchSqlWhereClause({
      userId: session.user.id,
      query,
      buckets,
      credentialIds,
      scopes,
      type,
    })
    const orderByClause = buildFileSearchOrderBySql(sortBy, sortDir)

    const [countResult] = await prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "total"
      FROM "FileMetadata" fm
      WHERE ${whereClause}
    `)
    const total = Number(countResult?.total ?? 0)

    const results = await prisma.$queryRaw<SearchResultRow[]>(Prisma.sql`
      SELECT
        fm."id",
        fm."key",
        fm."bucket",
        fm."credentialId",
        fm."size",
        fm."lastModified"
      FROM "FileMetadata" fm
      WHERE ${whereClause}
      ORDER BY ${orderByClause}
      OFFSET ${skip}
      LIMIT ${take}
    `)

    // Map response
    const data = results.map((r) => ({
      id: r.id,
      key: r.key,
      bucket: r.bucket,
      credentialId: r.credentialId,
      size: Number(r.size),
      lastModified: r.lastModified.toISOString(),
    }))

    return NextResponse.json({ results: data, total })
  } catch (error) {
    console.error("Failed to search files:", error)
    return NextResponse.json({ error: "Failed to search files" }, { status: 500 })
  }
}
