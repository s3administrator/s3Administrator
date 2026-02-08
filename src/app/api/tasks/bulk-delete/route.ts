import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import {
  buildFileSearchWhereClause,
  parseScopes,
} from "@/lib/file-search"

interface BulkDeletePayload {
  query: string
  selectedType?: string
  selectedCredentialIds?: string[]
  selectedBucketScopes?: string[]
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = (await request.json()) as BulkDeletePayload
    const query = typeof body?.query === "string" ? body.query.trim() : ""
    const selectedType = typeof body?.selectedType === "string" ? body.selectedType : "all"
    const selectedCredentialIds = Array.isArray(body?.selectedCredentialIds)
      ? body.selectedCredentialIds.filter((value): value is string => typeof value === "string")
      : []
    const selectedBucketScopes = Array.isArray(body?.selectedBucketScopes)
      ? body.selectedBucketScopes.filter((value): value is string => typeof value === "string")
      : []

    if (query.length < 2) {
      return NextResponse.json(
        { error: "query must be at least 2 characters" },
        { status: 400 }
      )
    }

    const whereClause = buildFileSearchWhereClause({
      userId: session.user.id,
      query,
      credentialIds: selectedCredentialIds,
      scopes: parseScopes(selectedBucketScopes),
      type: selectedType,
    })

    const total = await prisma.fileMetadata.count({ where: whereClause })

    if (total === 0) {
      return NextResponse.json(
        { error: "No indexed files matched this selection" },
        { status: 400 }
      )
    }

    const task = await prisma.backgroundTask.create({
      data: {
        userId: session.user.id,
        type: "bulk_delete",
        title: `Bulk delete: ${query}`,
        status: "pending",
        payload: {
          query,
          selectedType,
          selectedCredentialIds,
          selectedBucketScopes,
        },
        progress: {
          total,
          deleted: 0,
          remaining: total,
        },
      },
      select: {
        id: true,
        type: true,
        title: true,
        status: true,
        progress: true,
      },
    })

    return NextResponse.json({ task })
  } catch (error) {
    console.error("Failed to create bulk delete task:", error)
    const message = error instanceof Error ? error.message : "Failed to create bulk delete task"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
