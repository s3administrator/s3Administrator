"use client"

import { useState, useRef, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Upload, X, CheckCircle, Loader2 } from "lucide-react"
import { toast } from "sonner"

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bucket: string
  prefix: string
  onUploadComplete: () => void
}

interface UploadFile {
  file: File
  progress: number
  status: "pending" | "uploading" | "done" | "error"
}

export function UploadDialog({
  open,
  onOpenChange,
  bucket,
  prefix,
  onUploadComplete,
}: UploadDialogProps) {
  const [files, setFiles] = useState<UploadFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return
    const newFiles = Array.from(fileList).map((file) => ({
      file,
      progress: 0,
      status: "pending" as const,
    }))
    setFiles((prev) => [...prev, ...newFiles])
  }, [])

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    addFiles(e.dataTransfer.files)
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleUpload() {
    if (files.length === 0) return
    setIsUploading(true)

    for (let i = 0; i < files.length; i++) {
      const uploadFile = files[i]
      if (uploadFile.status === "done") continue

      setFiles((prev) =>
        prev.map((f, idx) =>
          idx === i ? { ...f, status: "uploading" as const, progress: 0 } : f
        )
      )

      try {
        const key = prefix + uploadFile.file.name

        const presignRes = await fetch("/api/s3/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, key }),
        })

        if (!presignRes.ok) throw new Error("Failed to get upload URL")
        const { url } = await presignRes.json()

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open("PUT", url)
          xhr.setRequestHeader("Content-Type", uploadFile.file.type || "application/octet-stream")

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100)
              setFiles((prev) =>
                prev.map((f, idx) =>
                  idx === i ? { ...f, progress: pct } : f
                )
              )
            }
          }

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve()
            else reject(new Error(`Upload failed: ${xhr.status}`))
          }
          xhr.onerror = () => reject(new Error("Upload failed"))

          xhr.send(uploadFile.file)
        })

        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === i ? { ...f, status: "done" as const, progress: 100 } : f
          )
        )
      } catch {
        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === i ? { ...f, status: "error" as const } : f
          )
        )
      }
    }

    setIsUploading(false)
    toast.success("Upload complete")
    onUploadComplete()
  }

  function handleClose(open: boolean) {
    if (!isUploading) {
      setFiles([])
      onOpenChange(open)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
        </DialogHeader>

        <div
          className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors hover:border-primary/50 hover:bg-muted/50"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Drag files here or click to browse
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>

        {files.length > 0 && (
          <div className="max-h-60 space-y-2 overflow-auto">
            {files.map((f, i) => (
              <div
                key={`${f.file.name}-${i}`}
                className="flex items-center gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{f.file.name}</p>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${f.progress}%` }}
                    />
                  </div>
                </div>
                {f.status === "done" ? (
                  <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />
                ) : f.status === "uploading" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeFile(i)
                    }}
                    className="shrink-0"
                  >
                    <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={isUploading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={files.length === 0 || isUploading}
          >
            {isUploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Upload {files.length > 0 && `(${files.length})`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
