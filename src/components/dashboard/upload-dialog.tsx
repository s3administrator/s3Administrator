"use client"

import { useState, useRef, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Upload, X, CheckCircle, Loader2, FolderUp } from "lucide-react"
import { toast } from "sonner"

const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024
const MULTIPART_CHUNK_SIZE = 8 * 1024 * 1024
const MAX_PART_RETRIES = 3

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
  status: "pending" | "uploading" | "done" | "error"
  error?: string
}

interface MultipartPart {
  ETag: string
  PartNumber: number
}

function normalizeRelativePath(file: File): string {
  const raw = file.webkitRelativePath || file.name
  return raw.replace(/^\/+/, "")
}

function isCorsLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return (
    normalized.includes("cors") ||
    normalized.includes("preflight") ||
    normalized.includes("access-control-allow-origin")
  )
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const ensuredCorsBucketsRef = useRef<Set<string>>(new Set())
  const uploadedCount = files.filter((item) => item.status === "done").length
  const failedCount = files.filter((item) => item.status === "error").length
  const processedCount = uploadedCount + failedCount
  const allUploadsDone = files.length > 0 && uploadedCount === files.length

  const setFileAt = useCallback((index: number, updater: (file: UploadFile) => UploadFile) => {
    setFiles((prev) => prev.map((item, idx) => (idx === index ? updater(item) : item)))
  }, [])

  const addFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return

    const incoming = Array.from(fileList).map((file) => ({
      file,
      relativePath: normalizeRelativePath(file),
      progress: 0,
      status: "pending" as const,
    }))

    setFiles((prev) => {
      const seen = new Set(
        prev.map((item) => `${item.relativePath}:${item.file.size}:${item.file.lastModified}`)
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

  const ensureBucketCors = useCallback(async (): Promise<boolean> => {
    const scope = `${credentialId ?? "default"}::${bucket}`
    if (ensuredCorsBucketsRef.current.has(scope)) {
      return true
    }

    try {
      const res = await fetch("/api/s3/cors/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket,
          credentialId,
          origin: window.location.origin,
        }),
      })

      if (!res.ok) {
        return false
      }

      ensuredCorsBucketsRef.current.add(scope)
      return true
    } catch {
      return false
    }
  }, [bucket, credentialId])

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    addFiles(e.dataTransfer.files)
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  async function uploadBlobToSignedUrl(
    url: string,
    blob: Blob,
    contentType: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open("PUT", url)
      xhr.setRequestHeader("Content-Type", contentType || "application/octet-stream")

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(event.loaded, event.total)
        }
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.getResponseHeader("ETag"))
        } else if (xhr.status === 0) {
          reject(
            new Error(
              "Upload failed due to CORS/network preflight. Ensure bucket CORS allows this app origin."
            )
          )
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`))
        }
      }

      xhr.onerror = () =>
        reject(
          new Error(
            "Upload failed due to CORS/network preflight. Ensure bucket CORS allows this app origin."
          )
        )

      xhr.send(blob)
    })
  }

  async function uploadSinglePut(uploadFile: UploadFile, index: number, key: string) {
    const presignRes = await fetch("/api/s3/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket, credentialId, key }),
    })

    if (!presignRes.ok) {
      throw new Error("Failed to get upload URL")
    }

    const { url } = await presignRes.json()

    await uploadBlobToSignedUrl(
      url,
      uploadFile.file,
      uploadFile.file.type,
      (loaded, total) => {
        const pct = Math.round((loaded / total) * 100)
        setFileAt(index, (item) => ({ ...item, progress: pct }))
      }
    )
  }

  async function requestMultipartPartUrl(
    key: string,
    uploadId: string,
    partNumber: number
  ): Promise<string> {
    const res = await fetch("/api/s3/upload/multipart/part", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket,
        key,
        credentialId,
        uploadId,
        partNumber,
      }),
    })

    if (!res.ok) {
      throw new Error("Failed to get multipart part URL")
    }

    const data = await res.json()
    return data.url as string
  }

  async function uploadMultipart(uploadFile: UploadFile, index: number, key: string) {
    const startRes = await fetch("/api/s3/upload/multipart/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket,
        key,
        credentialId,
        contentType: uploadFile.file.type,
      }),
    })

    if (!startRes.ok) {
      throw new Error("Failed to start multipart upload")
    }

    const { uploadId } = await startRes.json()
    if (!uploadId) {
      throw new Error("Missing uploadId")
    }

    const fileSize = uploadFile.file.size
    const totalParts = Math.ceil(fileSize / MULTIPART_CHUNK_SIZE)
    const parts: MultipartPart[] = []
    let uploadedBytes = 0

    try {
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        const start = (partNumber - 1) * MULTIPART_CHUNK_SIZE
        const end = Math.min(fileSize, start + MULTIPART_CHUNK_SIZE)
        const chunk = uploadFile.file.slice(start, end)

        let partETag: string | null = null

        for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt++) {
          try {
            const partUrl = await requestMultipartPartUrl(key, uploadId, partNumber)
            partETag = await uploadBlobToSignedUrl(
              partUrl,
              chunk,
              uploadFile.file.type,
              (loaded) => {
                const pct = Math.round(((uploadedBytes + loaded) / fileSize) * 100)
                setFileAt(index, (item) => ({ ...item, progress: pct }))
              }
            )
            break
          } catch {
            if (attempt === MAX_PART_RETRIES) {
              throw new Error(`Part ${partNumber} failed after ${MAX_PART_RETRIES} retries`)
            }
          }
        }

        if (!partETag) {
          throw new Error(`Missing ETag for part ${partNumber}`)
        }

        parts.push({
          PartNumber: partNumber,
          ETag: partETag,
        })

        uploadedBytes += chunk.size
        const pct = Math.round((uploadedBytes / fileSize) * 100)
        setFileAt(index, (item) => ({ ...item, progress: pct }))
      }

      const completeRes = await fetch("/api/s3/upload/multipart/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket,
          key,
          credentialId,
          uploadId,
          parts,
        }),
      })

      if (!completeRes.ok) {
        throw new Error("Failed to complete multipart upload")
      }
    } catch (error) {
      await fetch("/api/s3/upload/multipart/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket, key, credentialId, uploadId }),
      }).catch(() => {
        // best-effort cleanup
      })

      throw error
    }
  }

  async function uploadWithCorsRetry(uploadFile: UploadFile, index: number, key: string) {
    try {
      if (uploadFile.file.size >= LARGE_FILE_THRESHOLD) {
        await uploadMultipart(uploadFile, index, key)
      } else {
        await uploadSinglePut(uploadFile, index, key)
      }
      return
    } catch (error) {
      if (!isCorsLikeError(error)) {
        throw error
      }
    }

    const configured = await ensureBucketCors()
    if (!configured) {
      throw new Error(
        "Upload blocked by bucket CORS. Could not auto-configure CORS with current credentials."
      )
    }

    if (uploadFile.file.size >= LARGE_FILE_THRESHOLD) {
      await uploadMultipart(uploadFile, index, key)
    } else {
      await uploadSinglePut(uploadFile, index, key)
    }
  }

  async function handleUpload() {
    if (files.length === 0) return
    setIsUploading(true)

    const uploadedItems: Array<{ key: string; size: number; lastModified: string }> = []

    // Best effort: configure bucket CORS once up front.
    await ensureBucketCors()

    for (let i = 0; i < files.length; i++) {
      const uploadFile = files[i]
      if (uploadFile.status === "done") continue

      setFileAt(i, (item) => ({
        ...item,
        status: "uploading",
        progress: 0,
        error: undefined,
      }))

      try {
        const key = prefix + uploadFile.relativePath

        await uploadWithCorsRetry(uploadFile, i, key)

        setFileAt(i, (item) => ({
          ...item,
          status: "done",
          progress: 100,
          error: undefined,
        }))

        uploadedItems.push({
          key,
          size: uploadFile.file.size,
          lastModified: new Date().toISOString(),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed"
        setFileAt(i, (item) => ({ ...item, status: "error", error: message }))
      }
    }

    if (uploadedItems.length > 0) {
      try {
        await fetch("/api/s3/upload/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bucket,
            credentialId,
            items: uploadedItems,
          }),
        })
      } catch {
        // Metadata can still be refreshed via manual sync; upload itself already succeeded.
      }
    }

    setIsUploading(false)

    if (uploadedItems.length === files.length) {
      toast.success(`Upload complete (${uploadedItems.length}/${files.length})`)
    } else if (uploadedItems.length === 0) {
      toast.error("Upload failed. Check bucket CORS configuration and try again.")
    } else {
      toast.error(`Uploaded ${uploadedItems.length}/${files.length}. Some files failed.`)
    }

    if (uploadedItems.length > 0) {
      try {
        await onUploadComplete()
      } catch {
        toast.error("Upload finished, but bucket sync failed")
      }
    }
  }

  function handleClose(openState: boolean) {
    if (!isUploading) {
      setFiles([])
      onOpenChange(openState)
    }
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
      <DialogContent className="max-w-lg">
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
        </div>

        {files.length > 0 && (
          <div className="max-h-60 space-y-2 overflow-auto">
            {files.map((item, index) => (
              <div
                key={`${item.relativePath}-${index}`}
                className="flex items-center gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{item.relativePath}</p>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                  {item.error ? (
                    <p className="mt-1 text-xs text-destructive">{item.error}</p>
                  ) : null}
                </div>

                {item.status === "done" ? (
                  <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />
                ) : item.status === "uploading" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      removeFile(index)
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
            onClick={() => void handlePrimaryAction()}
            disabled={files.length === 0 || isUploading}
          >
            {isUploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            {isUploading
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
