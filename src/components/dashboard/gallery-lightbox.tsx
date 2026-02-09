"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react"
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
  bucket: string
  credentialId?: string
  onNavigate: (index: number) => void
}

export function GalleryLightbox({
  open,
  onOpenChange,
  items,
  currentIndex,
  bucket,
  credentialId,
  onNavigate,
}: GalleryLightboxProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeItem = useMemo(() => items[currentIndex] ?? null, [items, currentIndex])

  const fetchPreviewUrl = useCallback(async () => {
    if (!open || !activeItem) return
    setLoading(true)
    setError(null)
    setPreviewUrl(null)

    try {
      const res = await fetch("/api/s3/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket,
          credentialId,
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
  }, [activeItem, bucket, credentialId, open])

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
            activeItem.isVideo ? (
              <video
                src={previewUrl}
                controls
                className="max-h-[80vh] max-w-full rounded object-contain"
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
