export const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "svg",
] as const

export const VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "m4v",
] as const

export const GALLERY_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
] as const

export type MediaType = "image" | "video"

const IMAGE_SET = new Set<string>(IMAGE_EXTENSIONS)
const VIDEO_SET = new Set<string>(VIDEO_EXTENSIONS)

export function normalizeExtension(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^\./, "")
}

export function getMediaTypeFromExtension(
  extension: string | null | undefined
): MediaType | null {
  const normalized = normalizeExtension(extension)
  if (!normalized) return null
  if (IMAGE_SET.has(normalized)) return "image"
  if (VIDEO_SET.has(normalized)) return "video"
  return null
}

export function isVideoExtension(extension: string | null | undefined): boolean {
  return getMediaTypeFromExtension(extension) === "video"
}

export function getGalleryExtensions(filter: "all" | "image" | "video"): string[] {
  if (filter === "image") return [...IMAGE_EXTENSIONS]
  if (filter === "video") return [...VIDEO_EXTENSIONS]
  return [...GALLERY_EXTENSIONS]
}
