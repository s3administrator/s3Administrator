import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import {
  buildFileSearchWhereClause,
  parseCsvValues,
  parseScopes,
} from "@/lib/file-search"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = request.nextUrl
    const query = searchParams.get("q") || ""
    const bucketsParam = searchParams.get("buckets") || ""
    const credentialIdsParam = searchParams.get("credentialIds") || ""
    const scopeParams = searchParams.getAll("scope")
    const type = searchParams.get("type") || ""
    const sortBy = (searchParams.get("sortBy") || "name") as "name" | "size" | "lastModified"
    const sortDir = (searchParams.get("sortDir") || "asc") as "asc" | "desc"
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

    const whereClause = buildFileSearchWhereClause({
      userId: session.user.id,
      query,
      buckets,
      credentialIds,
      scopes,
      type,
    })

    const total = await prisma.fileMetadata.count({ where: whereClause })

    // Query database
    const results = await prisma.fileMetadata.findMany({
      where: whereClause,
      select: {
        id: true,
        key: true,
        bucket: true,
        credentialId: true,
        size: true,
        lastModified: true,
      },
      orderBy:
        sortBy === "name"
          ? { key: sortDir }
          : sortBy === "size"
            ? { size: sortDir }
            : { lastModified: sortDir },
      skip,
      take,
    })

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
