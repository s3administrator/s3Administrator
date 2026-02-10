import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { VIDEO_EXTENSIONS } from "@/lib/media"

type TaskStatus = "pending" | "in_progress" | "completed" | "failed"

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const scope = request.nextUrl.searchParams.get("scope") ?? "ongoing"
    const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "8")
    const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.floor(limitRaw))) : 8

    const statuses: TaskStatus[] =
      scope === "all"
        ? ["pending", "in_progress", "completed", "failed"]
        : ["pending", "in_progress", "failed"]

    const [tasks, cachedFiles, totalVideoFiles, readyThumbnails, pendingThumbnails, failedThumbnails] = await Promise.all([
      prisma.backgroundTask.findMany({
        where: {
          userId: session.user.id,
          status: {
            in: statuses,
          },
        },
        orderBy: [
          {
            updatedAt: "desc",
          },
        ],
        take: limit,
        select: {
          id: true,
          type: true,
          title: true,
          status: true,
          progress: true,
          attempts: true,
          maxAttempts: true,
          lastError: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
        },
      }),
      prisma.fileMetadata.count({
        where: {
          userId: session.user.id,
          isFolder: false,
        },
      }),
      prisma.fileMetadata.count({
        where: {
          userId: session.user.id,
          isFolder: false,
          extension: {
            in: [...VIDEO_EXTENSIONS],
          },
        },
      }),
      prisma.mediaThumbnail.count({
        where: {
          userId: session.user.id,
          status: "ready",
        },
      }),
      prisma.mediaThumbnail.count({
        where: {
          userId: session.user.id,
          status: {
            in: ["pending", "processing"],
          },
        },
      }),
      prisma.mediaThumbnail.count({
        where: {
          userId: session.user.id,
          status: "failed",
        },
      }),
    ])

    return NextResponse.json({
      tasks,
      summary: {
        cachedFiles,
        thumbnails: {
          ready: readyThumbnails,
          total: totalVideoFiles,
          pending: pendingThumbnails,
          failed: failedThumbnails,
        },
      },
    })
  } catch (error) {
    console.error("Failed to list tasks:", error)
    const message = error instanceof Error ? error.message : "Failed to list tasks"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
