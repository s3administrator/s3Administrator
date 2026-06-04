"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Upload,
  X,
  Loader2,
  FolderUp,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react"
import { toast } from "sonner"
import {
  UploadEngine,
  type UploadState,
} from "@/lib/upload-engine"
import {
  getPersistedUploads,
  removeUploadState,
  type PersistedUploadState,
} from "@/lib/upload-persistence"
import { formatSize } from "@/lib/format"
import { UploadFileItem } from "@/components/dashboard/upload-file-item"

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bucket: string
  credentialId?: string
  prefix: string
  onUploadComplete: () => void | Promise<void>
}

interface UploadFile {
  file: File
  relativePath: string
  progress: number
  speed: number
  status: "pending" | "uploading" | "paused" | "completing" | "done" | "error"
  error?: string
  engine?: UploadEngine
}

function normalizeRelativePath(file: File): string {
  const raw = file.webkitRelativePath || file.name
  return raw.replace(/^\/+/, "")
}


export function UploadDialog({
  open,
  onOpenChange,
  bucket,
  credentialId,
  prefix,
  onUploadComplete,
}: UploadDialogProps) {
  const [files, setFiles] = useState<UploadFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [persistedUploads, setPersistedUploads] = useState<PersistedUploadState[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const resumeFileInputRef = useRef<HTMLInputElement>(null)
  const resumeTargetRef = useRef<PersistedUploadState | null>(null)
  const enginesRef = useRef<Map<number, UploadEngine>>(new Map())

  const uploadedCount = files.filter((item) => item.status === "done").length
  const failedCount = files.filter((item) => item.status === "error").length
  const pausedCount = files.filter((item) => item.status === "paused").length
  const processedCount = uploadedCount + failedCount
  const allUploadsDone = files.length > 0 && uploadedCount === files.length
  const hasActiveUploads = files.some(
    (item) => item.status === "uploading" || item.status === "completing"
  )
  const hasPausedUploads = pausedCount > 0

  // Load persisted uploads when dialog opens
  useEffect(() => {
    if (open) {
      const persisted = getPersistedUploads().filter(
        (u) => u.bucket === bucket && u.credentialId === (credentialId ?? undefined)
      )
      setPersistedUploads(persisted)
    }
  }, [open, bucket, credentialId])

  // Warn before closing tab during uploads
  useEffect(() => {
    if (!hasActiveUploads) return

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }

    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [hasActiveUploads])

  const setFileAt = useCallback(
    (index: number, updater: (file: UploadFile) => UploadFile) => {
      setFiles((prev) =>
        prev.map((item, idx) => (idx === index ? updater(item) : item))
      )
    },
    []
  )

  const addFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return

    const incoming = Array.from(fileList).map((file) => ({
      file,
      relativePath: normalizeRelativePath(file),
      progress: 0,
      speed: 0,
      status: "pending" as const,
    }))

    setFiles((prev) => {
      const seen = new Set(
        prev.map(
          (item) =>
            `${item.relativePath}:${item.file.size}:${item.file.lastModified}`
        )
      )

      const dedupedIncoming = incoming.filter((item) => {
        const key = `${item.relativePath}:${item.file.size}:${item.file.lastModified}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      return [...prev, ...dedupedIncoming]
    })
  }, [])

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    addFiles(e.dataTransfer.files)
  }

  function removeFile(index: number) {
    const engine = enginesRef.current.get(index)
    if (engine) {
      engine.destroy()
      enginesRef.current.delete(index)
    }
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  function createEngine(file: File, key: string, index: number): UploadEngine {
    const engine = new UploadEngine({
      bucket,
      key,
      credentialId,
      file,
      contentType: file.type || "application/octet-stream",
      callbacks: {
        onProgress: (bytesUploaded, totalBytes, speed) => {
          const pct = Math.min(Math.round((bytesUploaded / totalBytes) * 100), 100)
          setFileAt(index, (item) => ({
            ...item,
            // Never decrease progress — on pause, in-flight bytes are lost
            // but the bar should hold at the last known position
            progress: Math.max(item.progress, pct),
            speed,
          }))
        },
        onStateChange: (state: UploadState) => {
          const statusMap: Record<UploadState, UploadFile["status"]> = {
            idle: "pending",
            uploading: "uploading",
            paused: "paused",
            completing: "completing",
            done: "done",
            error: "error",
          }
          setFileAt(index, (item) => ({ ...item, status: statusMap[state] }))
        },
        onComplete: () => {
          setFileAt(index, (item) => ({
            ...item,
            status: "done",
            progress: 100,
            speed: 0,
          }))
        },
        onError: (error: Error) => {
          setFileAt(index, (item) => ({
            ...item,
            status: "error",
            error: error.message,
            speed: 0,
          }))
        },
      },
    })

    enginesRef.current.set(index, engine)
    return engine
  }

  async function handleUpload() {
    if (files.length === 0) return
    setIsUploading(true)
    const uploadedItems: Array<{ key: string; size: number; lastModified: string }> = []

    for (let i = 0; i < files.length; i++) {
      const uploadFile = files[i]
      if (uploadFile.status === "done") continue

      const key = prefix + uploadFile.relativePath
      const engine = createEngine(uploadFile.file, key, i)

      setFileAt(i, (item) => ({
        ...item,
        status: "uploading",
        progress: 0,
        speed: 0,
        error: undefined,
        engine,
      }))

      try {
        // start() stays alive through pause/resume cycles via the pause gate.
        // It only resolves when the upload is fully done, errored, or aborted.
        await engine.start()

        if (engine.getState() === "done") {
          uploadedItems.push({
            key,
            size: uploadFile.file.size,
            lastModified: new Date().toISOString(),
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed"
        setFileAt(i, (item) => ({
          ...item,
          status: "error",
          error: message,
          speed: 0,
        }))
      }
    }

    // All engines have resolved — finalize
    if (uploadedItems.length > 0) {
      try {
        await fetch("/api/s3/upload/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, credentialId, items: uploadedItems }),
        })
      } catch (error) {
        console.warn("Failed to update metadata after upload:", error)
      }
    }

    setIsUploading(false)

    const totalFiles = files.length
    if (uploadedItems.length === totalFiles && totalFiles > 0) {
      toast.success(`Upload complete (${uploadedItems.length}/${totalFiles})`)
    } else if (uploadedItems.length === 0 && totalFiles > 0) {
      toast.error("Upload failed. Check bucket CORS configuration and try again.")
    } else if (uploadedItems.length > 0) {
      toast.error(`Uploaded ${uploadedItems.length}/${totalFiles}. Some files failed.`)
    }

    if (uploadedItems.length > 0) {
      try {
        await onUploadComplete()
      } catch {
        toast.error("Upload finished, but bucket sync failed")
      }
    }
  }

  function handlePauseFile(index: number) {
    const engine = enginesRef.current.get(index)
    if (engine) {
      engine.pause()
    }
  }

  function handleResumeFile(index: number) {
    const engine = enginesRef.current.get(index)
    if (engine) {
      engine.resume() // synchronous — opens the pause gate, workers continue
    }
  }

  function handlePauseAll() {
    for (const engine of enginesRef.current.values()) {
      if (engine.getState() === "uploading") {
        engine.pause()
      }
    }
  }

  function handleResumeAll() {
    for (const engine of enginesRef.current.values()) {
      if (engine.getState() === "paused") {
        engine.resume()
      }
    }
  }

  function handleDiscardPersistedUpload(upload: PersistedUploadState) {
    removeUploadState(upload.uploadId)
    setPersistedUploads((prev) =>
      prev.filter((u) => u.uploadId !== upload.uploadId)
    )

    // Best-effort abort on S3
    fetch("/api/s3/upload/multipart/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket: upload.bucket,
        key: upload.key,
        credentialId: upload.credentialId,
        uploadId: upload.uploadId,
      }),
    }).catch((error) => console.warn("Failed to abort persisted upload on S3:", error))
  }

  function handleResumePersistedUpload(upload: PersistedUploadState) {
    resumeTargetRef.current = upload
    resumeFileInputRef.current?.click()
  }

  async function handleResumeFileSelected(fileList: FileList | null) {
    const savedUpload = resumeTargetRef.current
    resumeTargetRef.current = null
    if (!fileList || fileList.length === 0 || !savedUpload) return

    const file = fileList[0]

    // Validate file matches
    if (
      file.name !== savedUpload.fileName ||
      file.size !== savedUpload.fileSize ||
      file.lastModified !== savedUpload.fileLastModified
    ) {
      toast.error(
        "Selected file does not match the original upload. Please select the same file."
      )
      return
    }

    setIsUploading(true)

    const index = files.length
    const newFile: UploadFile = {
      file,
      relativePath: savedUpload.key.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), ""),
      progress: Math.round(
        (savedUpload.completedPartNumbers.length / savedUpload.totalParts) * 100
      ),
      speed: 0,
      status: "uploading",
    }

    setFiles((prev) => [...prev, newFile])

    const engine = createEngine(file, savedUpload.key, index)

    try {
      // Stays alive through pause/resume cycles
      await engine.resumeFromPersistedState(savedUpload)

      if (engine.getState() === "done") {
        // Remove from persisted list
        setPersistedUploads((prev) =>
          prev.filter((u) => u.uploadId !== savedUpload.uploadId)
        )

        try {
          await fetch("/api/s3/upload/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bucket,
              credentialId,
              items: [{ key: savedUpload.key, size: file.size, lastModified: new Date().toISOString() }],
            }),
          })
        } catch (error) {
          console.warn("Failed to update metadata after resumed upload:", error)
        }

        toast.success("Upload resumed and completed")

        try {
          await onUploadComplete()
        } catch {
          toast.error("Upload finished, but bucket sync failed")
        }
      }
    } catch (error) {
      console.warn("Resume upload failed (handled via engine callbacks):", error)
    }

    setIsUploading(false)
  }

  function handleClose(openState: boolean) {
    if (hasActiveUploads || hasPausedUploads) return

    // Cleanup engines
    for (const engine of enginesRef.current.values()) {
      engine.destroy()
    }
    enginesRef.current.clear()

    setFiles([])
    onOpenChange(openState)
  }

  async function handlePrimaryAction() {
    if (allUploadsDone) {
      handleClose(false)
      return
    }

    await handleUpload()
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
        </DialogHeader>

        <div
          className="flex min-h-[130px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors hover:border-primary/50 hover:bg-muted/50"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Drag files/folders here or click to browse
          </p>

          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(event) => {
                event.stopPropagation()
                fileInputRef.current?.click()
              }}
            >
              Select Files
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(event) => {
                event.stopPropagation()
                folderInputRef.current?.click()
              }}
            >
              <FolderUp className="mr-1.5 h-4 w-4" />
              Select Folder
            </Button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => addFiles(event.target.files)}
          />
          <input
            ref={(node) => {
              folderInputRef.current = node
              if (node) {
                node.setAttribute("webkitdirectory", "")
                node.setAttribute("directory", "")
              }
            }}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => addFiles(event.target.files)}
          />
          {/* Hidden input for resume file selection */}
          <input
            ref={resumeFileInputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              void handleResumeFileSelected(event.target.files)
              event.target.value = ""
            }}
          />
        </div>

        {/* Resumable uploads from previous sessions */}
        {persistedUploads.length > 0 && (
          <div className="space-y-2 overflow-hidden border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">
              Resumable uploads
            </p>
            {persistedUploads.map((upload) => (
              <div
                key={upload.uploadId}
                className="flex items-center gap-2 overflow-hidden rounded-md border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{upload.fileName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatSize(upload.fileSize)} &mdash;{" "}
                    {upload.completedPartNumbers.length}/{upload.totalParts} parts
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => handleResumePersistedUpload(upload)}
                  disabled={isUploading}
                >
                  <RotateCcw className="mr-1.5 h-3 w-3" />
                  Resume
                </Button>
                <button
                  type="button"
                  onClick={() => handleDiscardPersistedUpload(upload)}
                  className="shrink-0"
                >
                  <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
            ))}
          </div>
        )}

        {files.length > 0 && (
          <div className="max-h-60 space-y-2 overflow-auto">
            {files.map((item, index) => (
              <UploadFileItem
                key={`${item.relativePath}-${index}`}
                relativePath={item.relativePath}
                fileSize={item.file.size}
                progress={item.progress}
                speed={item.speed}
                status={item.status}
                error={item.error}
                onPause={() => handlePauseFile(index)}
                onResume={() => handleResumeFile(index)}
                onRemove={() => removeFile(index)}
              />
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {hasPausedUploads && (
            <Button variant="outline" size="sm" onClick={handleResumeAll}>
              <Play className="mr-1.5 h-3 w-3" />
              Resume All
            </Button>
          )}
          {hasActiveUploads && (
            <Button variant="outline" size="sm" onClick={handlePauseAll}>
              <Pause className="mr-1.5 h-3 w-3" />
              Pause All
            </Button>
          )}
          <div className="flex-1" />
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={hasActiveUploads || hasPausedUploads}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handlePrimaryAction()}
            disabled={files.length === 0 || hasActiveUploads || hasPausedUploads}
          >
            {hasActiveUploads ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {hasActiveUploads
              ? `Uploading ${processedCount}/${files.length}`
              : allUploadsDone
                ? "Continue"
                : `Upload${files.length > 0 ? ` (${files.length})` : ""}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
