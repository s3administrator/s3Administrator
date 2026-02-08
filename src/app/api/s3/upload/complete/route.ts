import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { getObjectExtension, rebuildUserExtensionStats } from "@/lib/file-stats"

interface UploadCompleteItem {
  key: string
  size: number
  lastModified?: string
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const bucket = typeof body?.bucket === "string" ? body.bucket : ""
    const credentialId = typeof body?.credentialId === "string" ? body.credentialId : undefined
    const items = Array.isArray(body?.items) ? (body.items as UploadCompleteItem[]) : []

    if (!bucket || items.length === 0) {
      return NextResponse.json(
        { error: "bucket and items are required" },
        { status: 400 }
      )
    }

    const { credential } = await getS3Client(session.user.id, credentialId)

    for (const item of items) {
      if (!item?.key || typeof item.key !== "string") continue
      const size = Number.isFinite(item.size) && item.size >= 0 ? item.size : 0
      const lastModified = item.lastModified ? new Date(item.lastModified) : new Date()

      await prisma.fileMetadata.upsert({
        where: {
          credentialId_bucket_key: {
            credentialId: credential.id,
            bucket,
            key: item.key,
          },
        },
        create: {
          userId: session.user.id,
          credentialId: credential.id,
          bucket,
          key: item.key,
          extension: getObjectExtension(item.key, false),
          size: BigInt(size),
          lastModified,
          isFolder: false,
        },
        update: {
          extension: getObjectExtension(item.key, false),
          size: BigInt(size),
          lastModified,
          isFolder: false,
        },
      })
    }

    await rebuildUserExtensionStats(session.user.id)

    return NextResponse.json({ updated: items.length })
  } catch (error) {
    console.error("Failed to finalize uploaded metadata:", error)
    const message = error instanceof Error ? error.message : "Failed to finalize uploaded metadata"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
