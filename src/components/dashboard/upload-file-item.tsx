"use client"

import {
  X,
  CheckCircle,
  Loader2,
  Pause,
  Play,
} from "lucide-react"
import { shouldUseMultipart } from "@/lib/upload-engine"
import { formatSpeed, formatEta } from "@/lib/format"

interface UploadFileItemProps {
  relativePath: string
  fileSize: number
  progress: number
  speed: number
  status: "pending" | "uploading" | "paused" | "completing" | "done" | "error"
  error?: string
  onPause: () => void
  onResume: () => void
  onRemove: () => void
}

export function UploadFileItem({
  relativePath,
  fileSize,
  progress,
  speed,
  status,
  error,
  onPause,
  onResume,
  onRemove,
}: UploadFileItemProps) {
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{relativePath}</p>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
        {(status === "uploading" || status === "completing" || status === "paused") ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {progress}%
            {speed > 0
              ? ` — ${formatSpeed(speed)}`
              : ""}
            {speed > 0 && progress > 0 && progress < 100
              ? ` — ${formatEta(
                  fileSize * (1 - progress / 100),
                  speed
                )}`
              : ""}
          </p>
        ) : null}
        {error ? (
          <p className="mt-1 text-xs text-destructive">{error}</p>
        ) : null}
      </div>

      {status === "done" ? (
        <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />
      ) : status === "uploading" || status === "completing" ? (
        shouldUseMultipart(fileSize) ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onPause()
            }}
            className="shrink-0"
            title="Pause upload"
          >
            <Pause className="h-4 w-4 text-muted-foreground hover:text-foreground" />
          </button>
        ) : (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        )
      ) : status === "paused" ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onResume()
          }}
          className="shrink-0"
          title="Resume upload"
        >
          <Play className="h-4 w-4 text-muted-foreground hover:text-foreground" />
        </button>
      ) : (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
          className="shrink-0"
        >
          <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
        </button>
      )}
    </div>
  )
}
