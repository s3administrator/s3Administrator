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
  provider: z.enum(['AWS', 'HETZNER', 'CLOUDFLARE_R2', 'GENERIC']),
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
