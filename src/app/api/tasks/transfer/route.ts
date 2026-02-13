import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { getUserPlanEntitlements } from "@/lib/plan-entitlements"
import { getBucketLimitViolation } from "@/lib/plan-limits"
import {
  getObjectTransferDisabledMessage,
} from "@/lib/transfer-task-policy"
import { transferTaskSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

type TransferScope = "folder" | "bucket"
type TransferOperation = "sync" | "copy" | "move" | "migrate"
const SYNC_POLL_INTERVAL_SECONDS = 60

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

function getOperationDisabledMessage(scope: TransferScope, operation: TransferOperation): string | null {
  if (operation === "sync") {
    return "Sync tasks are disabled for the current plan"
  }
  if (scope === "folder" && (operation === "copy" || operation === "move")) {
    return "Folder transfer tasks are disabled for the current plan"
  }
  if (scope === "bucket" && (operation === "copy" || operation === "migrate")) {
    return "Bucket transfer tasks are disabled for the current plan"
  }
  return null
}

function isOperationEnabledByPlan(
  entitlements: NonNullable<Awaited<ReturnType<typeof getUserPlanEntitlements>>>,
  scope: TransferScope,
  operation: TransferOperation
): boolean {
  if (operation === "sync") {
    return entitlements.syncTasks
  }
  if (scope === "folder" && (operation === "copy" || operation === "move")) {
    return entitlements.copyFolderToFolder
  }
  if (scope === "bucket" && (operation === "copy" || operation === "migrate")) {
    return entitlements.copyBucketToBucket
  }
  return false
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

    const entitlements = await getUserPlanEntitlements(session.user.id)
    if (!entitlements || !entitlements.transferTasks) {
      return NextResponse.json(
        {
          error: getObjectTransferDisabledMessage(),
          details: {
            plan: entitlements?.slug ?? "free",
            planSource: entitlements?.source ?? "default",
          },
        },
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

    if (!isOperationEnabledByPlan(entitlements, scope, operation)) {
      return NextResponse.json(
        {
          error: getOperationDisabledMessage(scope, operation) ?? "Transfer operation is disabled for the current plan",
          details: {
            plan: entitlements.slug,
            planSource: entitlements.source,
            scope,
            operation,
          },
        },
        { status: 403 }
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

    const destinationContextChanged =
      sourceCredential.id !== destinationCredential.id ||
      sourceBucket !== destinationBucket
    if (destinationContextChanged) {
      const bucketLimitViolation = await getBucketLimitViolation({
        userId: session.user.id,
        credentialId: destinationCredential.id,
        bucket: destinationBucket,
        entitlements,
      })
      if (bucketLimitViolation) {
        return NextResponse.json(
          {
            error: "Bucket limit reached for current plan",
            details: bucketLimitViolation,
          },
          { status: 400 }
        )
      }
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

    if (sourceCachedFileCount === 0 && operation !== "sync") {
      return NextResponse.json(
        { error: "No cached source files matched this task" },
        { status: 400 }
      )
    }

    if (operation === "copy" || operation === "sync") {
      if (Number.isFinite(entitlements.fileLimit)) {
        const currentCachedFiles = await prisma.fileMetadata.count({
          where: {
            userId: session.user.id,
            isFolder: false,
          },
        })

        const projectedUpperBound = currentCachedFiles + sourceCachedFileCount
        if (projectedUpperBound > entitlements.fileLimit) {
          return NextResponse.json(
            {
              error:
                "Task could exceed your cached file limit. Upgrade or reduce source scope.",
              details: {
                currentCachedFiles,
                sourceCachedFileCount,
                fileLimit: entitlements.fileLimit,
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
          pollIntervalSeconds: operation === "sync" ? SYNC_POLL_INTERVAL_SECONDS : null,
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
      note:
        operation === "sync"
          ? "Sync mirrors cached source files and deletes destination-only cached files in the selected scope."
          : "Only cached source files are processed for transfer tasks.",
    })
  } catch (error) {
    console.error("Failed to create transfer task:", error)
    const message = error instanceof Error ? error.message : "Failed to create transfer task"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
