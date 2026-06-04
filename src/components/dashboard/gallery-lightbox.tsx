"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Download, Loader2, X } from "lucide-react"
import type { GalleryItem } from "@/types"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface GalleryLightboxProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: GalleryItem[]
  currentIndex: number
  apiPrefix?: string
  bucket?: string
  credentialId?: string
  getItemBucket?: (item: GalleryItem) => string | undefined
  getItemCredentialId?: (item: GalleryItem) => string | undefined
  onNavigate: (index: number) => void
  onDownload?: (item: GalleryItem) => void
}

export function GalleryLightbox({
  open,
  onOpenChange,
  items,
  currentIndex,
  apiPrefix = "/api/s3",
  bucket,
  credentialId,
  getItemBucket,
  getItemCredentialId,
  onNavigate,
  onDownload,
}: GalleryLightboxProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [videoError, setVideoError] = useState(false)

  const activeItem = useMemo(() => items[currentIndex] ?? null, [items, currentIndex])

  const fetchPreviewUrl = useCallback(async () => {
    if (!open || !activeItem) return

    setError(null)
    setVideoError(false)

    if (activeItem.previewUrl) {
      setPreviewUrl(activeItem.previewUrl)
      setLoading(false)
      return
    }

    const resolvedBucket = getItemBucket?.(activeItem) ?? bucket
    if (!resolvedBucket) {
      setError("Missing preview bucket")
      setPreviewUrl(null)
      setLoading(false)
      return
    }

    const resolvedCredentialId = getItemCredentialId?.(activeItem) ?? credentialId

    setLoading(true)
    setPreviewUrl(null)

    try {
      const res = await fetch(`${apiPrefix}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket: resolvedBucket,
          credentialId: resolvedCredentialId,
          key: activeItem.key,
        }),
      })
      if (!res.ok) {
        throw new Error("Failed to load preview")
      }
      const data = await res.json()
      if (typeof data?.url !== "string" || !data.url) {
        throw new Error("Preview URL is missing")
      }
      setPreviewUrl(data.url)
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "Failed to load preview"
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [activeItem, apiPrefix, bucket, credentialId, getItemBucket, getItemCredentialId, open])

  useEffect(() => {
    void fetchPreviewUrl()
  }, [fetchPreviewUrl])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false)
        return
      }
      if (event.key === "ArrowLeft") {
        onNavigate(Math.max(0, currentIndex - 1))
        return
      }
      if (event.key === "ArrowRight") {
        onNavigate(Math.min(items.length - 1, currentIndex + 1))
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [currentIndex, items.length, onNavigate, onOpenChange, open])

  const canGoPrev = currentIndex > 0
  const canGoNext = currentIndex < items.length - 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="truncate text-sm font-medium">
            {activeItem?.key ?? "Preview"}
          </DialogTitle>
        </DialogHeader>

        <div className="relative flex min-h-[65vh] items-center justify-center bg-black/90 p-4">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="absolute left-4 top-1/2 z-20 h-9 w-9 -translate-y-1/2"
            onClick={() => canGoPrev && onNavigate(currentIndex - 1)}
            disabled={!canGoPrev}
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>

          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="absolute right-4 top-1/2 z-20 h-9 w-9 -translate-y-1/2"
            onClick={() => canGoNext && onNavigate(currentIndex + 1)}
            disabled={!canGoNext}
          >
            <ChevronRight className="h-5 w-5" />
          </Button>

          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="absolute right-4 top-4 z-20 h-8 w-8"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </Button>

          {loading ? (
            <div className="flex items-center gap-2 text-white">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading preview...</span>
            </div>
          ) : error ? (
            <p className="text-sm text-red-300">{error}</p>
          ) : previewUrl && activeItem ? (
            activeItem.isVideo && videoError ? (
              <div className="flex flex-col items-center gap-3 text-white">
                <p className="text-sm text-white/70">
                  This video format is not supported for browser playback.
                </p>
                {onDownload && (
                  <Button variant="secondary" size="sm" onClick={() => onDownload(activeItem)}>
                    <Download className="mr-2 h-4 w-4" />
                    Download to view
                  </Button>
                )}
              </div>
            ) : activeItem.isVideo ? (
              <video
                src={previewUrl}
                controls
                className="max-h-[80vh] max-w-full rounded object-contain"
                onError={() => setVideoError(true)}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt={activeItem.key}
                className="max-h-[80vh] max-w-full rounded object-contain"
              />
            )
          ) : (
            <p className="text-sm text-white/70">No preview available</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
