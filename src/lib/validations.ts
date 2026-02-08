import { z } from "zod/v4"

export const addCredentialSchema = z.object({
  label: z.string().min(1).max(100),
  provider: z.enum(['AWS', 'HETZNER', 'CLOUDFLARE_R2', 'GENERIC']),
  endpoint: z.string().min(1),
  region: z.string().min(1).max(50),
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
})

export const listObjectsSchema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().optional(),
  credentialId: z.string().optional(),
})

export const deleteObjectsSchema = z.object({
  bucket: z.string().min(1),
  keys: z.array(z.string()).optional(),
  prefixes: z.array(z.string()).optional(),
})

export const moveObjectSchema = z.object({
  bucket: z.string().min(1),
  sourceBucket: z.string().optional(),
  operations: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
    })
  ),
})

export const searchObjectsSchema = z.object({
  bucket: z.string().min(1),
  query: z.string().min(1),
  credentialId: z.string().optional(),
})

export const createFolderSchema = z.object({
  bucket: z.string().min(1),
  key: z.string().min(1),
})
