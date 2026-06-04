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
  // Version fields (present when "Show Versions" is on)
  versionId?: string
  isLatest?: boolean
  isDeleteMarker?: boolean
}

export interface ListObjectsResponse {
  folders: S3Object[]
  files: S3Object[]
  nextToken?: string
}

export type MediaType = "image" | "video"

export type PreviewType = "image" | "video" | "audio" | "pdf" | "text" | "csv" | "office" | "odf" | "code"

export interface GalleryItem {
  id: string
  key: string
  size: number
  lastModified: string
  extension: string
  mediaType: MediaType | null
  previewType: PreviewType | null
  previewUrl: string | null
  isVideo: boolean
  isFolder: boolean
  fileCount?: number
  totalSize?: number
}

export interface GalleryResponse {
  items: GalleryItem[]
  nextCursor: string | null
  hasMore: boolean
}

export type Tier = "free" | "pro" | "team"
