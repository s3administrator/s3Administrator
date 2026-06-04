import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import { previewSchema } from "@/lib/validations"
import { GetObjectCommand } from "@aws-sdk/client-s3"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditKey = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-preview-proxy", 120, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const parsed = previewSchema.safeParse({
      bucket: request.nextUrl.searchParams.get("bucket") ?? "",
      key: request.nextUrl.searchParams.get("key") ?? "",
      credentialId: request.nextUrl.searchParams.get("credentialId") ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 })
    }

    const { bucket, key, credentialId } = parsed.data
    auditBucket = bucket
    auditKey = key

    const { client } = await getS3Client(session.user.id, credentialId)

    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    )

    if (!response.Body) {
      return NextResponse.json({ error: "Empty response from storage" }, { status: 502 })
    }

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "preview_proxy",
      path: "/api/s3/preview/proxy",
      method: "GET",
      target: key,
      metadata: {
        bucket,
        credentialId: credentialId ?? null,
      },
      ...requestContext,
    })

    const headers = new Headers()
    headers.set("Content-Disposition", "inline")
    if (response.ContentType) {
      headers.set("Content-Type", response.ContentType)
    }
    if (response.ContentLength != null) {
      headers.set("Content-Length", String(response.ContentLength))
    }
    headers.set("Cache-Control", "public, max-age=300")

    const webStream = response.Body.transformToWebStream()
    return new NextResponse(webStream, { status: 200, headers })
  } catch (error) {
    console.error("Preview proxy failed:", error)
    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "preview_proxy_failed",
        path: "/api/s3/preview/proxy",
        method: "GET",
        target: auditKey || undefined,
        metadata: {
          bucket: auditBucket || null,
          error: error instanceof Error ? error.message : "preview_proxy_failed",
        },
        ...requestContext,
      })
    }
    return NextResponse.json({ error: "Failed to preview object" }, { status: 500 })
  }
}
