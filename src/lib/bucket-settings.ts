import {
  DeleteBucketCorsCommand,
  DeleteBucketLifecycleCommand,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  type CORSRule,
  type LifecycleRule,
  type S3Client,
} from "@aws-sdk/client-s3"
import type { Provider } from "@/lib/providers"

export const MANAGED_CORS_RULE_ID = "s3-admin-managed-cors-v1"
export const MANAGED_LIFECYCLE_RULE_ID = "s3-admin-managed-lifecycle-v1"

const DEFAULT_CORS_METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE"]
const DEFAULT_CORS_HEADERS = ["*"]
const DEFAULT_EXPOSE_HEADERS = ["ETag", "x-amz-request-id", "x-amz-id-2", "x-amz-version-id"]
const DEFAULT_MAX_AGE_SECONDS = 3600
const STORADERA_CORS_UNSUPPORTED_REASON = "CORS is not supported by Storadera"
const STORADERA_LIFECYCLE_UNSUPPORTED_REASON = "Lifecycle rules are not supported by Storadera"

type BucketSettingName = "cors" | "versioning" | "lifecycle"

type ErrorClassificationKind = "unsupported" | "permission" | "missing_bucket" | "unknown"

interface ErrorClassification {
  kind: ErrorClassificationKind
  reason: string
}

interface S3ErrorDetails {
  code: string
  message: string
  status: number | null
}

export interface BucketSettingCapability {
  supported: boolean
  reason?: string
}

export interface BucketSettingsCapabilities {
  cors: BucketSettingCapability
  versioning: BucketSettingCapability
  lifecycle: BucketSettingCapability
}

export interface BucketCorsSettings {
  enabled: boolean
  allowedOrigins: string[]
  allowedMethods: string[]
  allowedHeaders: string[]
  exposeHeaders: string[]
  maxAgeSeconds: number
}

export interface BucketVersioningSettings {
  status: "enabled" | "suspended" | "unversioned"
}

export interface BucketLifecycleSettings {
  enabled: boolean
  expirationDays: number | null
}

export interface BucketSettingsSnapshot {
  capabilities: BucketSettingsCapabilities
  settings: {
    cors: BucketCorsSettings
    versioning: BucketVersioningSettings
    lifecycle: BucketLifecycleSettings
  }
}

function getProviderCapabilityOverride(
  provider: Provider,
  setting: BucketSettingName
): BucketSettingCapability | null {
  if (provider === "STORADERA" && setting === "cors") {
    return {
      supported: false,
      reason: STORADERA_CORS_UNSUPPORTED_REASON,
    }
  }

  if (provider === "STORADERA" && setting === "lifecycle") {
    return {
      supported: false,
      reason: STORADERA_LIFECYCLE_UNSUPPORTED_REASON,
    }
  }

  return null
}

function toUniqueStrings(values: Array<string | undefined> | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
}

function readErrorDetails(error: unknown): S3ErrorDetails {
  if (!error || typeof error !== "object") {
    return {
      code: "",
      message: "Unknown S3 error",
      status: null,
    }
  }

  const candidate = error as {
    name?: unknown
    code?: unknown
    Code?: unknown
    message?: unknown
    Message?: unknown
    $metadata?: unknown
  }

  const code =
    typeof candidate.Code === "string"
      ? candidate.Code
      : typeof candidate.code === "string"
        ? candidate.code
        : typeof candidate.name === "string"
          ? candidate.name
          : ""

  let status: number | null = null
  if (
    candidate.$metadata &&
    typeof candidate.$metadata === "object" &&
    "httpStatusCode" in candidate.$metadata
  ) {
    const httpStatusCode = (candidate.$metadata as { httpStatusCode?: unknown }).httpStatusCode
    if (typeof httpStatusCode === "number") {
      status = httpStatusCode
    }
  }

  const message =
    typeof candidate.message === "string"
      ? candidate.message
      : typeof candidate.Message === "string"
        ? candidate.Message
        : code
          ? `S3 error: ${code}`
          : "Unknown S3 error"

  return { code, message, status }
}

function isNoCorsConfigurationError(error: unknown): boolean {
  const details = readErrorDetails(error)
  return details.code === "NoSuchCORSConfiguration" || details.code === "NoSuchCORS"
}

function isNoLifecycleConfigurationError(error: unknown): boolean {
  const details = readErrorDetails(error)
  return details.code === "NoSuchLifecycleConfiguration"
}

function classifyBucketSettingError(
  error: unknown,
  provider: Provider,
  setting: BucketSettingName
): ErrorClassification {
  const providerCapabilityOverride = getProviderCapabilityOverride(provider, setting)
  if (providerCapabilityOverride && !providerCapabilityOverride.supported) {
    return {
      kind: "unsupported",
      reason: providerCapabilityOverride.reason ?? "Not supported by this provider/API",
    }
  }

  const details = readErrorDetails(error)
  const normalizedMessage = details.message.toLowerCase()

  if (details.code === "NoSuchBucket") {
    return {
      kind: "missing_bucket",
      reason: "Bucket was not found",
    }
  }

  const unsupportedCodes = new Set([
    "NotImplemented",
    "UnsupportedOperation",
    "MethodNotAllowed",
    "XNotImplemented",
  ])
  const unsupportedByCode = unsupportedCodes.has(details.code)
  const unsupportedByStatus = details.status === 405 || details.status === 501
  const unsupportedByMessage =
    normalizedMessage.includes("not implemented") ||
    normalizedMessage.includes("not supported")

  if (
    setting === "versioning" &&
    provider === "CLOUDFLARE_R2" &&
    (unsupportedByCode || unsupportedByStatus || unsupportedByMessage)
  ) {
    return {
      kind: "unsupported",
      reason: "Versioning is not supported by Cloudflare R2",
    }
  }

  if (unsupportedByCode || unsupportedByStatus || unsupportedByMessage) {
    return {
      kind: "unsupported",
      reason: "Not supported by this provider/API",
    }
  }

  const permissionByStatus = details.status === 401 || details.status === 403
  const permissionByCode =
    details.code.includes("AccessDenied") ||
    details.code.includes("Unauthorized") ||
    details.code.includes("Forbidden")

  if (permissionByStatus || permissionByCode) {
    return {
      kind: "permission",
      reason: "Permission denied for this setting",
    }
  }

  return {
    kind: "unknown",
    reason: details.message,
  }
}

function defaultCorsSettings(): BucketCorsSettings {
  return {
    enabled: false,
    allowedOrigins: [],
    allowedMethods: [...DEFAULT_CORS_METHODS],
    allowedHeaders: [...DEFAULT_CORS_HEADERS],
    exposeHeaders: [...DEFAULT_EXPOSE_HEADERS],
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
  }
}

async function readCorsSettings(params: {
  client: S3Client
  bucket: string
  provider: Provider
}): Promise<{ capability: BucketSettingCapability; settings: BucketCorsSettings }> {
  const fallback = defaultCorsSettings()
  const providerCapabilityOverride = getProviderCapabilityOverride(params.provider, "cors")
  if (providerCapabilityOverride) {
    return {
      capability: providerCapabilityOverride,
      settings: fallback,
    }
  }

  try {
    const response = await params.client.send(
      new GetBucketCorsCommand({ Bucket: params.bucket })
    )

    const managedRule = (response.CORSRules ?? []).find(
      (rule) => rule.ID === MANAGED_CORS_RULE_ID
    )

    if (!managedRule) {
      return {
        capability: { supported: true },
        settings: fallback,
      }
    }

    return {
      capability: { supported: true },
      settings: {
        enabled: true,
        allowedOrigins: toUniqueStrings(managedRule.AllowedOrigins),
        allowedMethods: toUniqueStrings(managedRule.AllowedMethods),
        allowedHeaders: toUniqueStrings(managedRule.AllowedHeaders),
        exposeHeaders: toUniqueStrings(managedRule.ExposeHeaders),
        maxAgeSeconds:
          typeof managedRule.MaxAgeSeconds === "number"
            ? Math.max(0, managedRule.MaxAgeSeconds)
            : DEFAULT_MAX_AGE_SECONDS,
      },
    }
  } catch (error) {
    if (isNoCorsConfigurationError(error)) {
      return {
        capability: { supported: true },
        settings: fallback,
      }
    }

    const classification = classifyBucketSettingError(error, params.provider, "cors")
    return {
      capability: {
        supported: false,
        reason: classification.reason,
      },
      settings: fallback,
    }
  }
}

async function readVersioningSettings(params: {
  client: S3Client
  bucket: string
  provider: Provider
}): Promise<{ capability: BucketSettingCapability; settings: BucketVersioningSettings }> {
  const fallback: BucketVersioningSettings = {
    status: "unversioned",
  }

  try {
    const response = await params.client.send(
      new GetBucketVersioningCommand({ Bucket: params.bucket })
    )

    const status =
      response.Status === "Enabled"
        ? "enabled"
        : response.Status === "Suspended"
          ? "suspended"
          : "unversioned"

    return {
      capability: { supported: true },
      settings: { status },
    }
  } catch (error) {
    const classification = classifyBucketSettingError(error, params.provider, "versioning")

    return {
      capability: {
        supported: false,
        reason: classification.reason,
      },
      settings: fallback,
    }
  }
}

async function readLifecycleSettings(params: {
  client: S3Client
  bucket: string
  provider: Provider
}): Promise<{ capability: BucketSettingCapability; settings: BucketLifecycleSettings }> {
  const fallback: BucketLifecycleSettings = {
    enabled: false,
    expirationDays: null,
  }
  const providerCapabilityOverride = getProviderCapabilityOverride(params.provider, "lifecycle")
  if (providerCapabilityOverride) {
    return {
      capability: providerCapabilityOverride,
      settings: fallback,
    }
  }

  try {
    const response = await params.client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: params.bucket })
    )

    const managedRule = (response.Rules ?? []).find(
      (rule) => rule.ID === MANAGED_LIFECYCLE_RULE_ID
    )

    if (!managedRule) {
      return {
        capability: { supported: true },
        settings: fallback,
      }
    }

    const expirationDays =
      typeof managedRule.Expiration?.Days === "number" && managedRule.Expiration.Days > 0
        ? managedRule.Expiration.Days
        : null

    return {
      capability: { supported: true },
      settings: {
        enabled: managedRule.Status === "Enabled" && expirationDays !== null,
        expirationDays,
      },
    }
  } catch (error) {
    if (isNoLifecycleConfigurationError(error)) {
      return {
        capability: { supported: true },
        settings: fallback,
      }
    }

    const classification = classifyBucketSettingError(error, params.provider, "lifecycle")
    return {
      capability: {
        supported: false,
        reason: classification.reason,
      },
      settings: fallback,
    }
  }
}

export async function getBucketSettingsSnapshot(params: {
  client: S3Client
  bucket: string
  provider: Provider
}): Promise<BucketSettingsSnapshot> {
  const [cors, versioning, lifecycle] = await Promise.all([
    readCorsSettings(params),
    readVersioningSettings(params),
    readLifecycleSettings(params),
  ])

  return {
    capabilities: {
      cors: cors.capability,
      versioning: versioning.capability,
      lifecycle: lifecycle.capability,
    },
    settings: {
      cors: cors.settings,
      versioning: versioning.settings,
      lifecycle: lifecycle.settings,
    },
  }
}

async function loadCorsRules(client: S3Client, bucket: string): Promise<CORSRule[]> {
  try {
    const response = await client.send(new GetBucketCorsCommand({ Bucket: bucket }))
    return response.CORSRules ?? []
  } catch (error) {
    if (isNoCorsConfigurationError(error)) {
      return []
    }
    throw error
  }
}

async function saveCorsRules(params: {
  client: S3Client
  bucket: string
  rules: CORSRule[]
}) {
  if (params.rules.length === 0) {
    await params.client.send(new DeleteBucketCorsCommand({ Bucket: params.bucket }))
    return
  }

  await params.client.send(
    new PutBucketCorsCommand({
      Bucket: params.bucket,
      CORSConfiguration: {
        CORSRules: params.rules,
      },
    })
  )
}

export async function updateManagedBucketCorsSettings(params: {
  client: S3Client
  bucket: string
  settings: BucketCorsSettings
}) {
  const currentRules = await loadCorsRules(params.client, params.bucket)
  const preservedRules = currentRules.filter((rule) => rule.ID !== MANAGED_CORS_RULE_ID)

  if (!params.settings.enabled) {
    await saveCorsRules({
      client: params.client,
      bucket: params.bucket,
      rules: preservedRules,
    })
    return
  }

  const managedRule: CORSRule = {
    ID: MANAGED_CORS_RULE_ID,
    AllowedOrigins: toUniqueStrings(params.settings.allowedOrigins),
    AllowedMethods: toUniqueStrings(params.settings.allowedMethods),
    AllowedHeaders: toUniqueStrings(params.settings.allowedHeaders),
    ExposeHeaders: toUniqueStrings(params.settings.exposeHeaders),
    MaxAgeSeconds: Math.max(0, Math.floor(params.settings.maxAgeSeconds)),
  }

  await saveCorsRules({
    client: params.client,
    bucket: params.bucket,
    rules: [...preservedRules, managedRule],
  })
}

async function loadLifecycleRules(client: S3Client, bucket: string): Promise<LifecycleRule[]> {
  try {
    const response = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
    )
    return response.Rules ?? []
  } catch (error) {
    if (isNoLifecycleConfigurationError(error)) {
      return []
    }
    throw error
  }
}

async function saveLifecycleRules(params: {
  client: S3Client
  bucket: string
  rules: LifecycleRule[]
}) {
  if (params.rules.length === 0) {
    await params.client.send(new DeleteBucketLifecycleCommand({ Bucket: params.bucket }))
    return
  }

  await params.client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: params.bucket,
      LifecycleConfiguration: {
        Rules: params.rules,
      },
    })
  )
}

export async function updateManagedBucketLifecycleSettings(params: {
  client: S3Client
  bucket: string
  settings: BucketLifecycleSettings
}) {
  const currentRules = await loadLifecycleRules(params.client, params.bucket)
  const preservedRules = currentRules.filter((rule) => rule.ID !== MANAGED_LIFECYCLE_RULE_ID)

  if (!params.settings.enabled || !params.settings.expirationDays) {
    await saveLifecycleRules({
      client: params.client,
      bucket: params.bucket,
      rules: preservedRules,
    })
    return
  }

  const managedRule: LifecycleRule = {
    ID: MANAGED_LIFECYCLE_RULE_ID,
    Status: "Enabled",
    Filter: { Prefix: "" },
    Expiration: {
      Days: Math.max(1, Math.floor(params.settings.expirationDays)),
    },
  }

  await saveLifecycleRules({
    client: params.client,
    bucket: params.bucket,
    rules: [...preservedRules, managedRule],
  })
}

export async function updateBucketVersioningSetting(params: {
  client: S3Client
  bucket: string
  enabled: boolean
}) {
  await params.client.send(
    new PutBucketVersioningCommand({
      Bucket: params.bucket,
      VersioningConfiguration: {
        Status: params.enabled ? "Enabled" : "Suspended",
      },
    })
  )
}

export function getSettingFailureReason(params: {
  error: unknown
  provider: Provider
  setting: BucketSettingName
}): ErrorClassification {
  return classifyBucketSettingError(params.error, params.provider, params.setting)
}
