import { NextRequest, NextResponse } from "next/server"
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  type CORSRule,
} from "@aws-sdk/client-s3"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

const UPLOAD_CORS_RULE_ID = "s3-admin-browser-upload"
const REQUIRED_METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE"]
const REQUIRED_EXPOSE_HEADERS = ["ETag", "x-amz-request-id", "x-amz-id-2", "x-amz-version-id"]

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
}

function isNoCorsConfigError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown }
  const code = typeof candidate.Code === "string"
    ? candidate.Code
    : typeof candidate.code === "string"
      ? candidate.code
      : typeof candidate.name === "string"
        ? candidate.name
        : ""

  return code === "NoSuchCORSConfiguration" || code === "NoSuchCORS"
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const bucket = typeof body?.bucket === "string" ? body.bucket.trim() : ""
    const credentialId = typeof body?.credentialId === "string" ? body.credentialId : undefined
    const requestedOrigin = typeof body?.origin === "string"
      ? normalizeOrigin(body.origin)
      : normalizeOrigin(request.headers.get("origin") ?? "")

    if (!bucket) {
      return NextResponse.json({ error: "bucket is required" }, { status: 400 })
    }

    if (!requestedOrigin) {
      return NextResponse.json({ error: "origin is required" }, { status: 400 })
    }

    const { client } = await getS3Client(session.user.id, credentialId)

    let existingRules: CORSRule[] = []
    try {
      const existing = await client.send(new GetBucketCorsCommand({ Bucket: bucket }))
      existingRules = existing.CORSRules ?? []
    } catch (error) {
      if (!isNoCorsConfigError(error)) {
        throw error
      }
    }

    const ruleIndex = existingRules.findIndex((rule) => rule.ID === UPLOAD_CORS_RULE_ID)
    const currentRule = ruleIndex >= 0 ? existingRules[ruleIndex] : undefined

    const nextRule: CORSRule = {
      ID: UPLOAD_CORS_RULE_ID,
      AllowedMethods: uniqueStrings([
        ...(currentRule?.AllowedMethods ?? []),
        ...REQUIRED_METHODS,
      ]),
      AllowedHeaders: uniqueStrings([
        ...(currentRule?.AllowedHeaders ?? []),
        "*",
      ]),
      ExposeHeaders: uniqueStrings([
        ...(currentRule?.ExposeHeaders ?? []),
        ...REQUIRED_EXPOSE_HEADERS,
      ]),
      AllowedOrigins: uniqueStrings([
        ...(currentRule?.AllowedOrigins ?? []),
        requestedOrigin,
      ]),
      MaxAgeSeconds: currentRule?.MaxAgeSeconds ?? 3600,
    }

    const nextRules = [...existingRules]
    if (ruleIndex >= 0) {
      nextRules[ruleIndex] = nextRule
    } else {
      nextRules.push(nextRule)
    }

    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: nextRules,
        },
      })
    )

    return NextResponse.json({
      updated: true,
      bucket,
      origin: requestedOrigin,
      ruleId: UPLOAD_CORS_RULE_ID,
    })
  } catch (error) {
    console.error("Failed to ensure bucket CORS:", error)
    return NextResponse.json({ error: "Failed to ensure bucket CORS" }, { status: 500 })
  }
}
