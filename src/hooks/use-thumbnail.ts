"use client"

import { useEffect, useRef, useState } from "react"
import type { GalleryItem } from "@/types"
import { getOrGenerateThumbnail } from "@/lib/client-thumbnail"
import { clearOldThumbnails } from "@/lib/thumbnail-db"

// Run one-time cleanup of old IndexedDB entries per page load
let cleanupScheduled = false
function scheduleCleanup() {
  if (cleanupScheduled) return
  cleanupScheduled = true
  // Run after initial render to avoid blocking
  setTimeout(() => {
    clearOldThumbnails().catch(() => {})
  }, 5000)
}

export function useThumbnail(
  item: GalleryItem,
  credentialId: string,
  bucket: string
): {
  objectUrl: string | null
  isGenerating: boolean
  error: boolean
} {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState(false)
  // Track the current object URL so we can revoke it on cleanup / item change
  const currentUrlRef = useRef<string | null>(null)

  useEffect(() => {
    scheduleCleanup()
  }, [])

  useEffect(() => {
    if (item.isFolder || !item.mediaType) return

    let cancelled = false

    setObjectUrl(null)
    setError(false)
    setIsGenerating(true)

    getOrGenerateThumbnail(item, credentialId, bucket)
      .then((blob) => {
        if (cancelled) return
        if (!blob) {
          setError(true)
          setIsGenerating(false)
          return
        }
        const url = URL.createObjectURL(blob)
        // Revoke previous object URL if any
        if (currentUrlRef.current) {
          URL.revokeObjectURL(currentUrlRef.current)
        }
        currentUrlRef.current = url
        setObjectUrl(url)
        setIsGenerating(false)
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
          setIsGenerating(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [item.key, item.lastModified, item.size, credentialId, bucket]) // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke object URL when component unmounts
  useEffect(() => {
    return () => {
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = null
      }
    }
  }, [])

  return { objectUrl, isGenerating, error }
}
