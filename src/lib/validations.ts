import { z } from "zod/v4"

// S3 bucket/key validation schemas for defense-in-depth
export const s3BucketSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9.\-]{0,61}[a-z0-9]$/,
    "Invalid bucket name"
  )

export const s3KeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((key) => !key.includes("\0"), "Key must not contain null bytes")
  .refine((key) => !key.includes("../"), "Key must not contain path traversal sequences")

export const s3OperationSchema = z.object({
  bucket: s3BucketSchema,
  key: s3KeySchema,
  credentialId: z.string().optional(),
})

export const addCredentialSchema = z.object({
  label: z.string().min(1).max(100),
  provider: z.enum(['AWS', 'HETZNER', 'CLOUDFLARE_R2', 'MINIO', 'GENERIC']),
  endpoint: z.string().min(1),
  region: z.string().min(1).max(50),
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
})

export const listObjectsSchema = z.object({
  bucket: s3BucketSchema,
  prefix: z.string().optional(),
  credentialId: z.string().optional(),
})

export const deleteObjectsSchema = z.object({
  bucket: s3BucketSchema,
  credentialId: z.string().optional(),
  keys: z.array(z.string()).optional(),
  prefixes: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
})

export const moveObjectSchema = z.object({
  bucket: s3BucketSchema,
  credentialId: z.string().optional(),
  sourceBucket: s3BucketSchema.optional(),
  operations: z.array(
    z.object({
      from: s3KeySchema,
      to: s3KeySchema,
    })
  ),
})

export const searchObjectsSchema = z.object({
  bucket: s3BucketSchema,
  query: z.string().min(1),
  credentialId: z.string().optional(),
})

export const createFolderSchema = z.object({
  bucket: s3BucketSchema,
  credentialId: z.string().optional(),
  key: s3KeySchema,
})

export const bucketManageSchema = z.object({
  bucket: s3BucketSchema,
  credentialId: z.string().optional(),
})

export const bucketCorsSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  allowedOrigins: z.array(z.string().min(1).max(2048)).max(100),
  allowedMethods: z.array(z.string().min(1).max(32)).max(20),
  allowedHeaders: z.array(z.string().min(1).max(1024)).max(100),
  exposeHeaders: z.array(z.string().min(1).max(1024)).max(100),
  maxAgeSeconds: z.number().int().min(0).max(86_400),
})

export const bucketVersioningSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
})

export const bucketLifecycleSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  expirationDays: z.number().int().min(1).max(36_500).nullable(),
})

export const bucketSettingsPatchSchema = z
  .object({
    bucket: s3BucketSchema,
    credentialId: z.string().optional(),
    cors: bucketCorsSettingsUpdateSchema.optional(),
    versioning: bucketVersioningSettingsUpdateSchema.optional(),
    lifecycle: bucketLifecycleSettingsUpdateSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const configuredSections = [value.cors, value.versioning, value.lifecycle].filter(Boolean)
    if (configuredSections.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one settings section must be provided",
      })
    }
  })

export const galleryListSchema = z.object({
  bucket: s3BucketSchema,
  credentialId: z.string().optional(),
  prefix: z.string().max(1024).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(120).default(60),
  mediaType: z.enum(["all", "image", "video"]).default("all"),
})

export const thumbnailRequestSchema = z.object({
  bucket: s3BucketSchema,
  credentialId: z.string().optional(),
  keys: z.array(s3KeySchema).min(1).max(200),
})

export const previewSchema = z.object({
  bucket: s3BucketSchema,
  credentialId: z.string().optional(),
  key: s3KeySchema,
})

export const transferTaskSchema = z.object({
  scope: z.enum(["folder", "bucket"]),
  operation: z.enum(["sync", "copy", "move", "migrate"]),
  sourceBucket: s3BucketSchema,
  sourceCredentialId: z.string().optional(),
  sourcePrefix: z.string().max(1024).optional(),
  destinationBucket: s3BucketSchema,
  destinationCredentialId: z.string().optional(),
  destinationPrefix: z.string().max(1024).optional(),
})
