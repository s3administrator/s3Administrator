export interface S3Bucket {
  name: string
  creationDate?: string
}

export interface S3Object {
  key: string
  size: number
  lastModified: string
  isFolder: boolean
  fileCount?: number
  totalSize?: number
}

export interface ListObjectsResponse {
  folders: S3Object[]
  files: S3Object[]
  nextToken?: string
}

export type Tier = "free" | "pro" | "team"
