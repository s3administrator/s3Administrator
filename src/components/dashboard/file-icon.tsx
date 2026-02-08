import {
  Folder,
  Image,
  FileText,
  Archive,
  Video,
  Music,
  File,
  FileCode,
  FileSpreadsheet,
  FileJson,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface FileIconProps {
  filename: string
  isFolder: boolean
  className?: string
}

const ICON_MAP: Record<string, typeof File> = {
  // Images
  ".jpg": Image,
  ".jpeg": Image,
  ".png": Image,
  ".gif": Image,
  ".svg": Image,
  ".webp": Image,
  ".bmp": Image,
  ".ico": Image,
  // Documents
  ".pdf": FileText,
  ".doc": FileText,
  ".docx": FileText,
  ".txt": FileText,
  ".rtf": FileText,
  // Archives
  ".zip": Archive,
  ".tar": Archive,
  ".gz": Archive,
  ".rar": Archive,
  ".7z": Archive,
  ".bz2": Archive,
  // Video
  ".mp4": Video,
  ".mov": Video,
  ".avi": Video,
  ".mkv": Video,
  ".webm": Video,
  ".wmv": Video,
  // Audio
  ".mp3": Music,
  ".wav": Music,
  ".flac": Music,
  ".aac": Music,
  ".ogg": Music,
  // Code
  ".js": FileCode,
  ".ts": FileCode,
  ".jsx": FileCode,
  ".tsx": FileCode,
  ".py": FileCode,
  ".rb": FileCode,
  ".go": FileCode,
  ".rs": FileCode,
  ".html": FileCode,
  ".css": FileCode,
  ".scss": FileCode,
  // Data
  ".json": FileJson,
  ".xml": FileJson,
  ".yaml": FileJson,
  ".yml": FileJson,
  ".csv": FileSpreadsheet,
  ".xls": FileSpreadsheet,
  ".xlsx": FileSpreadsheet,
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".")
  if (lastDot === -1) return ""
  return filename.slice(lastDot).toLowerCase()
}

export function FileIcon({ filename, isFolder, className }: FileIconProps) {
  if (isFolder) {
    return <Folder className={cn("h-5 w-5 text-yellow-500", className)} />
  }

  const ext = getExtension(filename)
  const Icon = ICON_MAP[ext] ?? File

  return <Icon className={cn("h-5 w-5 text-muted-foreground", className)} />
}
