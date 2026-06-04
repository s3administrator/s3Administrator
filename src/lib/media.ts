export const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
  "tiff",
  "tif",
  "ai",
] as const

export const VIDEO_EXTENSIONS = [
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "m4v",
] as const

export const AUDIO_EXTENSIONS = [
  "aac",
  "ac3",
  "aiff",
  "amr",
  "au",
  "flac",
  "mid",
  "mka",
  "mp3",
  "ogg",
  "ra",
  "voc",
  "wav",
  "wma",
] as const

export const ARCHIVE_EXTENSIONS = [
  "7z",
  "rar",
  "tar",
  "zip",
] as const

export const FONT_EXTENSIONS = [
  "otf",
  "ttf",
  "tff",
  "woff",
  "woff2",
] as const

export const PDF_EXTENSIONS = ["pdf"] as const

export const TEXT_EXTENSIONS = ["txt", "log", "md"] as const

export const CSV_EXTENSIONS = ["csv", "tsv"] as const

export const OFFICE_EXTENSIONS = [
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
] as const

export const ODF_EXTENSIONS = [
  "odt",
  "ods",
  "odp",
] as const

export const CODE_EXTENSIONS = [
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "cpp",
  "c",
  "css",
  "scss",
  "html",
  "json",
  "xml",
  "yaml",
  "yml",
  "php",
  "sh",
  "bash",
  "sql",
] as const

export const DOCUMENT_EXTENSIONS = [
  ...PDF_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...CSV_EXTENSIONS,
  ...OFFICE_EXTENSIONS,
  ...ODF_EXTENSIONS,
] as const

export const GALLERY_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  ...ARCHIVE_EXTENSIONS,
  ...FONT_EXTENSIONS,
  ...CODE_EXTENSIONS,
] as const

export const PREVIEWABLE_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...CODE_EXTENSIONS,
] as const

export type MediaType = "image" | "video"
export type PreviewType = "image" | "video" | "audio" | "pdf" | "text" | "csv" | "office" | "odf" | "code"

const IMAGE_SET = new Set<string>(IMAGE_EXTENSIONS)
const VIDEO_SET = new Set<string>(VIDEO_EXTENSIONS)
const AUDIO_SET = new Set<string>(AUDIO_EXTENSIONS)
const PDF_SET = new Set<string>(PDF_EXTENSIONS)
const TEXT_SET = new Set<string>(TEXT_EXTENSIONS)
const CSV_SET = new Set<string>(CSV_EXTENSIONS)
const OFFICE_SET = new Set<string>(OFFICE_EXTENSIONS)
const ODF_SET = new Set<string>(ODF_EXTENSIONS)
const CODE_SET = new Set<string>(CODE_EXTENSIONS)
const GALLERY_SET = new Set<string>(GALLERY_EXTENSIONS)
const PREVIEWABLE_SET = new Set<string>(PREVIEWABLE_EXTENSIONS)

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

export function isImageExtension(extension: string | null | undefined): boolean {
  return getMediaTypeFromExtension(extension) === "image"
}

const THUMBNAIL_UNSUPPORTED_IMAGE_EXTENSIONS = new Set(["ai"])

export function isThumbnailSupportedExtension(extension: string | null | undefined): boolean {
  const mediaType = getMediaTypeFromExtension(extension)
  if (!mediaType) return false
  if (mediaType === "image" && THUMBNAIL_UNSUPPORTED_IMAGE_EXTENSIONS.has(normalizeExtension(extension))) return false
  return true
}

export function getGalleryExtensions(filter: "all" | "image" | "video"): string[] {
  if (filter === "image") return [...IMAGE_EXTENSIONS]
  if (filter === "video") return [...VIDEO_EXTENSIONS]
  return [...GALLERY_EXTENSIONS]
}

export function isGallerySupportedExtension(
  extension: string | null | undefined
): boolean {
  return GALLERY_SET.has(normalizeExtension(extension))
}

export function getPreviewType(
  extension: string | null | undefined
): PreviewType | null {
  const normalized = normalizeExtension(extension)
  if (!normalized) return null
  if (IMAGE_SET.has(normalized)) return "image"
  if (VIDEO_SET.has(normalized)) return "video"
  if (AUDIO_SET.has(normalized)) return "audio"
  if (PDF_SET.has(normalized)) return "pdf"
  if (TEXT_SET.has(normalized)) return "text"
  if (CSV_SET.has(normalized)) return "csv"
  if (OFFICE_SET.has(normalized)) return "office"
  if (ODF_SET.has(normalized)) return "odf"
  if (CODE_SET.has(normalized)) return "code"
  return null
}

export function isPreviewableExtension(
  extension: string | null | undefined
): boolean {
  return PREVIEWABLE_SET.has(normalizeExtension(extension))
}
