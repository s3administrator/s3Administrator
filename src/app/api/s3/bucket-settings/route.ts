import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import {
  getBucketSettingsSnapshot,
  getSettingFailureReason,
  updateBucketVersioningSetting,
  updateManagedBucketCorsSettings,
  updateManagedBucketLifecycleSettings,
  type BucketCorsSettings,
} from "@/lib/bucket-settings"
import { type Provider } from "@/lib/providers"
import { getS3Client } from "@/lib/s3"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { bucketManageSchema, bucketSettingsPatchSchema } from "@/lib/validations"
import { getRequestContext, logUserAuditAction } from "@/lib/audit-logger"

const KNOWN_PROVIDERS = new Set<Provider>([
  "AWS",
  "HETZNER",
  "CLOUDFLARE_R2",
  "STORADERA",
  "MINIO",
  "GENERIC",
])

function normalizeProvider(value: string): Provider {
  if (KNOWN_PROVIDERS.has(value as Provider)) {
    return value as Provider
  }
  return "GENERIC"
}

function normalizeStringList(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  )
}

function toQueryPayload(request: NextRequest) {
  return {
    bucket: request.nextUrl.searchParams.get("bucket") ?? undefined,
    credentialId: request.nextUrl.searchParams.get("credentialId") ?? undefined,
  }
}

export async function GET(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditCredentialId = ""
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-bucket-settings-read", 120, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const parsed = bucketManageSchema.safeParse(toQueryPayload(request))
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId } = parsed.data
    auditBucket = bucket

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    auditCredentialId = credential.id
    const provider = normalizeProvider(credential.provider)

    const snapshot = await getBucketSettingsSnapshot({
      client,
      bucket,
      provider,
    })

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "bucket_settings_read",
      path: "/api/s3/bucket-settings",
      method: "GET",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        provider,
      },
      ...requestContext,
    })

    return NextResponse.json({
      bucket,
      credentialId: credential.id,
      credentialLabel: credential.label,
      provider,
      capabilities: snapshot.capabilities,
      settings: snapshot.settings,
    })
  } catch (error) {
    console.error("Failed to read bucket settings:", error)

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "bucket_settings_read_failed",
        path: "/api/s3/bucket-settings",
        method: "GET",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          credentialId: auditCredentialId || null,
          error: error instanceof Error ? error.message : "bucket_settings_read_failed",
        },
        ...requestContext,
      })
    }

    return NextResponse.json({ error: "Failed to read bucket settings" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  let userId: string | undefined
  let auditBucket = ""
  let auditCredentialId = ""
  let attemptedSetting: "cors" | "versioning" | "lifecycle" | null = null
  let provider: Provider = "GENERIC"
  const requestContext = getRequestContext(request)

  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    userId = session.user.id

    const limitResult = rateLimitByUser(session.user.id, "s3-bucket-settings-update", 60, 60_000)
    if (!limitResult.success) {
      return rateLimitResponse(limitResult.retryAfterSeconds)
    }

    const body = await request.json()
    const parsed = bucketSettingsPatchSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, credentialId, cors, versioning, lifecycle } = parsed.data
    auditBucket = bucket

    const { client, credential } = await getS3Client(session.user.id, credentialId)
    auditCredentialId = credential.id
    provider = normalizeProvider(credential.provider)

    const sectionName = cors ? "cors" : versioning ? "versioning" : "lifecycle"
    attemptedSetting = sectionName

    const currentSnapshot = await getBucketSettingsSnapshot({
      client,
      bucket,
      provider,
    })

    const capability = currentSnapshot.capabilities[sectionName]
    if (!capability.supported) {
      const reason = capability.reason ?? "Not supported by this provider/API"
      const status =
        reason === "Bucket was not found"
          ? 404
          : reason === "Permission denied for this setting"
            ? 403
            : 409
      return NextResponse.json(
        {
          error: reason,
          setting: sectionName,
        },
        { status }
      )
    }

    if (cors) {
      const normalizedCors: BucketCorsSettings = {
        enabled: cors.enabled,
        allowedOrigins: normalizeStringList(cors.allowedOrigins),
        allowedMethods: normalizeStringList(cors.allowedMethods),
        allowedHeaders: normalizeStringList(cors.allowedHeaders),
        exposeHeaders: normalizeStringList(cors.exposeHeaders),
        maxAgeSeconds: cors.maxAgeSeconds,
      }

      await updateManagedBucketCorsSettings({
        client,
        bucket,
        settings: normalizedCors,
      })
    } else if (versioning) {
      await updateBucketVersioningSetting({
        client,
        bucket,
        enabled: versioning.enabled,
      })
    } else if (lifecycle) {
      await updateManagedBucketLifecycleSettings({
        client,
        bucket,
        settings: {
          enabled: lifecycle.enabled,
          expirationDays: lifecycle.enabled ? lifecycle.expirationDays : null,
        },
      })
    }

    const nextSnapshot = await getBucketSettingsSnapshot({
      client,
      bucket,
      provider,
    })

    await logUserAuditAction({
      userId: session.user.id,
      eventType: "s3_action",
      eventName: "bucket_settings_update",
      path: "/api/s3/bucket-settings",
      method: "PATCH",
      target: bucket,
      metadata: {
        bucket,
        credentialId: credential.id,
        provider,
        section: sectionName,
      },
      ...requestContext,
    })

    return NextResponse.json({
      bucket,
      credentialId: credential.id,
      credentialLabel: credential.label,
      provider,
      capabilities: nextSnapshot.capabilities,
      settings: nextSnapshot.settings,
    })
  } catch (error) {
    console.error("Failed to update bucket settings:", error)

    if (userId && attemptedSetting) {
      const classification = getSettingFailureReason({
        error,
        provider,
        setting: attemptedSetting,
      })

      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "bucket_settings_update_failed",
        path: "/api/s3/bucket-settings",
        method: "PATCH",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          credentialId: auditCredentialId || null,
          provider,
          section: attemptedSetting,
          error: classification.reason,
          kind: classification.kind,
        },
        ...requestContext,
      })

      if (classification.kind === "unsupported") {
        return NextResponse.json(
          { error: classification.reason, setting: attemptedSetting },
          { status: 409 }
        )
      }
      if (classification.kind === "permission") {
        return NextResponse.json({ error: classification.reason }, { status: 403 })
      }
      if (classification.kind === "missing_bucket") {
        return NextResponse.json({ error: classification.reason }, { status: 404 })
      }
      return NextResponse.json({ error: classification.reason }, { status: 500 })
    }

    if (userId) {
      await logUserAuditAction({
        userId,
        eventType: "s3_action",
        eventName: "bucket_settings_update_failed",
        path: "/api/s3/bucket-settings",
        method: "PATCH",
        target: auditBucket || undefined,
        metadata: {
          bucket: auditBucket || null,
          credentialId: auditCredentialId || null,
          provider,
          error: error instanceof Error ? error.message : "bucket_settings_update_failed",
        },
        ...requestContext,
      })
    }

    return NextResponse.json({ error: "Failed to update bucket settings" }, { status: 500 })
  }
}
