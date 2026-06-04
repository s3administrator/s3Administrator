import { NextRequest, NextResponse } from "next/server"
import { Readable } from "node:stream"
import { Upload } from "@aws-sdk/lib-storage"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"
import { s3OperationSchema } from "@/lib/validations"

export const runtime = "nodejs"

export async function PUT(request: NextRequest) {
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

    const limitResult = rateLimitByUser(session.user.id, "s3-upload-proxy", 120, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const parsed = s3OperationSchema.safeParse({
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

    if (!request.body) {
      return NextResponse.json({ error: "Missing upload body" }, { status: 400 })
    }

    const { client } = await getS3Client(session.user.id, credentialId)
    const contentTypeHeader = request.headers.get("content-type")?.trim()
    const contentLength = Number(request.headers.get("content-length") || 0)
    const nodeStream = Readable.fromWeb(request.body as import("node:stream/web").ReadableStream)

    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: nodeStream,
        ContentType: contentTypeHeader || undefined,
        ...(contentLength > 0 ? { ContentLength: contentLength } : {}),
      },
    })

    await upload.done()

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "upload_proxy_put",
      path: "/api/s3/upload/proxy",
      method: "PUT",
      target: key,
      metadata: {
        bucket,
        credentialId: credentialId ?? null,
      },
      ...requestContext,
    })

    return NextResponse.json({ uploaded: true, key })
  } catch (error) {
    console.error("Proxy upload failed:", error)

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "upload_proxy_put_failed",
        path: "/api/s3/upload/proxy",
        method: "PUT",
        target: auditKey || undefined,
        metadata: {
          bucket: auditBucket || null,
          error: error instanceof Error ? error.message : "upload_proxy_put_failed",
        },
        ...requestContext,
      })
    }

    return NextResponse.json({ error: "Failed to upload object" }, { status: 500 })
  }
}
