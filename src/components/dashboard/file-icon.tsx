import {
  Folder,
  Image,
  FileText,
  Video,
  File,
  FileCode,
  FileSpreadsheet,
  FileJson,
  FileArchive,
  FileAudio,
  FileType2,
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
  ".tiff": Image,
  ".tif": Image,
  ".ai": Image,
  // Documents
  ".pdf": FileText,
  ".doc": FileText,
  ".docx": FileText,
  ".txt": FileText,
  ".rtf": FileText,
  ".odt": FileText,
  ".odp": FileText,
  ".ods": FileSpreadsheet,
  // Archives
  ".zip": FileArchive,
  ".tar": FileArchive,
  ".gz": FileArchive,
  ".rar": FileArchive,
  ".7z": FileArchive,
  ".bz2": FileArchive,
  // Video
  ".mp4": Video,
  ".mov": Video,
  ".avi": Video,
  ".mkv": Video,
  ".webm": Video,
  ".wmv": Video,
  // Audio
  ".aac": FileAudio,
  ".ac3": FileAudio,
  ".aiff": FileAudio,
  ".amr": FileAudio,
  ".au": FileAudio,
  ".flac": FileAudio,
  ".mid": FileAudio,
  ".mka": FileAudio,
  ".mp3": FileAudio,
  ".ogg": FileAudio,
  ".ra": FileAudio,
  ".voc": FileAudio,
  ".wav": FileAudio,
  ".wma": FileAudio,
  // Fonts
  ".otf": FileType2,
  ".ttf": FileType2,
  ".tff": FileType2,
  ".woff": FileType2,
  ".woff2": FileType2,
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
  ".java": FileCode,
  ".cpp": FileCode,
  ".c": FileCode,
  ".php": FileCode,
  ".sh": FileCode,
  ".bash": FileCode,
  ".sql": FileCode,
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
