import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { getTierLimits } from "@/lib/tiers"
import {
  getObjectTransferDisabledMessage,
  isObjectTransferEnabledForUser,
} from "@/lib/transfer-task-policy"
import { transferTaskSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

type TransferScope = "folder" | "bucket"
type TransferOperation = "sync" | "copy" | "move" | "migrate"

function normalizeFolderPrefix(raw: string | undefined): string {
  const value = (raw ?? "").trim()
  if (!value) return ""
  return value.endsWith("/") ? value : `${value}/`
}

function isOperationAllowed(scope: TransferScope, operation: TransferOperation): boolean {
  if (scope === "folder") {
    return operation === "sync" || operation === "copy" || operation === "move"
  }
  return operation === "sync" || operation === "copy" || operation === "migrate"
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const limitResult = rateLimitByUser(session.user.id, "task-transfer-create", 20, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const transferEnabled = await isObjectTransferEnabledForUser(session.user.id)
    if (!transferEnabled) {
      return NextResponse.json(
        { error: getObjectTransferDisabledMessage() },
        { status: 403 }
      )
    }

    const body = await request.json()
    const parsed = transferTaskSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const {
      scope,
      operation,
      sourceBucket,
      sourceCredentialId,
      sourcePrefix,
      destinationBucket,
      destinationCredentialId,
      destinationPrefix,
    } = parsed.data

    if (!isOperationAllowed(scope, operation)) {
      return NextResponse.json(
        { error: `Operation '${operation}' is not allowed for scope '${scope}'` },
        { status: 400 }
      )
    }

    const normalizedSourcePrefix = scope === "folder" ? normalizeFolderPrefix(sourcePrefix) : ""
    const normalizedDestinationPrefix = scope === "folder" ? normalizeFolderPrefix(destinationPrefix) : ""

    if (scope === "folder") {
      if (!normalizedSourcePrefix || !normalizedDestinationPrefix) {
        return NextResponse.json(
          { error: "sourcePrefix and destinationPrefix are required for folder tasks" },
          { status: 400 }
        )
      }
    }

    const { credential: sourceCredential } = await getS3Client(session.user.id, sourceCredentialId)
    const { credential: destinationCredential } = await getS3Client(
      session.user.id,
      destinationCredentialId
    )

    const sameSourceAndDestination =
      sourceCredential.id === destinationCredential.id &&
      sourceBucket === destinationBucket &&
      (scope === "bucket" || normalizedSourcePrefix === normalizedDestinationPrefix)

    if (sameSourceAndDestination) {
      return NextResponse.json(
        { error: "Source and destination cannot be identical" },
        { status: 400 }
      )
    }

    const sourceWhere = {
      userId: session.user.id,
      credentialId: sourceCredential.id,
      bucket: sourceBucket,
      isFolder: false,
      ...(scope === "folder" ? { key: { startsWith: normalizedSourcePrefix } } : {}),
    }

    const sourceCachedFileCount = await prisma.fileMetadata.count({
      where: sourceWhere,
    })

    if (sourceCachedFileCount === 0) {
      return NextResponse.json(
        { error: "No cached source files matched this task" },
        { status: 400 }
      )
    }

    if (operation === "copy" || operation === "sync") {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { tier: true },
      })

      const limits = getTierLimits(user?.tier ?? "free")

      if (Number.isFinite(limits.files)) {
        const currentCachedFiles = await prisma.fileMetadata.count({
          where: {
            userId: session.user.id,
            isFolder: false,
          },
        })

        const projectedUpperBound = currentCachedFiles + sourceCachedFileCount
        if (projectedUpperBound > limits.files) {
          return NextResponse.json(
            {
              error:
                "Task could exceed your cached file limit. Upgrade or reduce source scope.",
              details: {
                currentCachedFiles,
                sourceCachedFileCount,
                fileLimit: limits.files,
                projectedUpperBound,
              },
            },
            { status: 400 }
          )
        }
      }
    }

    const title =
      scope === "folder"
        ? `${operation.toUpperCase()} folder ${sourceBucket}/${normalizedSourcePrefix} -> ${destinationBucket}/${normalizedDestinationPrefix}`
        : `${operation.toUpperCase()} bucket ${sourceBucket} -> ${destinationBucket}`

    const task = await prisma.backgroundTask.create({
      data: {
        userId: session.user.id,
        type: "object_transfer",
        title,
        status: "pending",
        payload: {
          scope,
          operation,
          sourceCredentialId: sourceCredential.id,
          sourceBucket,
          sourcePrefix: normalizedSourcePrefix || null,
          destinationCredentialId: destinationCredential.id,
          destinationBucket,
          destinationPrefix: normalizedDestinationPrefix || null,
        },
        progress: {
          phase: "transfer",
          total: sourceCachedFileCount,
          processed: 0,
          copied: 0,
          moved: 0,
          deleted: 0,
          skipped: 0,
          failed: 0,
          remaining: sourceCachedFileCount,
          cursorKey: null,
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

    return NextResponse.json({
      task,
      sourceCachedFileCount,
      note: "Only cached source files are processed for transfer tasks.",
    })
  } catch (error) {
    console.error("Failed to create transfer task:", error)
    const message = error instanceof Error ? error.message : "Failed to create transfer task"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
