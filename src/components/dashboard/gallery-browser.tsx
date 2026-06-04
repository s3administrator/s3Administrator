"use client"

import { useEffect, useMemo, useRef } from "react"
import { Download, FolderOpen, ImageIcon, Loader2, Trash2, Video } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/dashboard/empty-state"
import { FileIcon } from "@/components/dashboard/file-icon"
import { formatSize, formatDate } from "@/lib/format"
import type { GalleryItem } from "@/types"
import { useThumbnail } from "@/hooks/use-thumbnail"

interface GalleryBrowserProps {
  items: GalleryItem[]
  isLoading: boolean
  isFetchingNextPage: boolean
  hasNextPage: boolean
  selectedKeys: Set<string>
  credentialId?: string
  bucket?: string
  getItemSelectionKey?: (item: GalleryItem) => string
  getItemCredentialId?: (item: GalleryItem) => string | undefined
  getItemBucket?: (item: GalleryItem) => string | undefined
  onSelect: (item: GalleryItem, options?: { shiftKey?: boolean }) => void
  onSelectAllVisible: () => void
  onNavigate: (item: GalleryItem) => void
  onOpenPreview: (item: GalleryItem) => void
  onDownload: (item: GalleryItem) => void
  onDelete: (item: GalleryItem) => void
  onLoadMore: () => void
  readOnly?: boolean
}

function getDisplayName(key: string): string {
  const normalized = key.endsWith("/") ? key.slice(0, -1) : key
  const parts = normalized.split("/")
  return parts[parts.length - 1] || key
}

interface GalleryItemCardProps {
  item: GalleryItem
  selected: boolean
  credentialId?: string
  bucket?: string
  getItemCredentialId?: (item: GalleryItem) => string | undefined
  getItemBucket?: (item: GalleryItem) => string | undefined
  shiftPressedRef: React.MutableRefObject<boolean>
  onSelect: (item: GalleryItem, options?: { shiftKey?: boolean }) => void
  onNavigate: (item: GalleryItem) => void
  onOpenPreview: (item: GalleryItem) => void
  onDownload: (item: GalleryItem) => void
  onDelete: (item: GalleryItem) => void
  readOnly?: boolean
}

function GalleryItemCard({
  item,
  selected,
  credentialId,
  bucket,
  getItemCredentialId,
  getItemBucket,
  shiftPressedRef,
  onSelect,
  onNavigate,
  onOpenPreview,
  onDownload,
  onDelete,
  readOnly,
}: GalleryItemCardProps) {
  const resolvedCredentialId = getItemCredentialId?.(item) ?? credentialId ?? ""
  const resolvedBucket = getItemBucket?.(item) ?? bucket ?? ""
  const { objectUrl, isGenerating } = useThumbnail(item, resolvedCredentialId, resolvedBucket)

  return (
    <div
      className={`group rounded-lg border transition ${selected ? "border-primary ring-1 ring-primary/40" : "border-border"}`}
    >
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (item.isFolder) {
              onNavigate(item)
            } else {
              onOpenPreview(item)
            }
          }}
          className="block h-40 w-full overflow-hidden rounded-t-lg bg-muted"
        >
          {item.isFolder ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 bg-amber-50/70 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              <FolderOpen className="h-10 w-10 fill-current/20" />
              <span className="text-xs">
                {typeof item.fileCount === "number"
                  ? `${item.fileCount} ${item.fileCount === 1 ? "file" : "files"}`
                  : "Folder"}
              </span>
            </div>
          ) : !item.mediaType ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <FileIcon filename={getDisplayName(item.key)} isFolder={false} className="h-10 w-10" />
              <span className="max-w-[80%] truncate text-xs uppercase">{item.extension || ""}</span>
            </div>
          ) : objectUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={objectUrl}
              alt={item.key}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : isGenerating ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              {item.isVideo ? <Video className="h-7 w-7" /> : <ImageIcon className="h-7 w-7" />}
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {item.isVideo ? (
                <Video className="h-7 w-7" />
              ) : (
                <ImageIcon className="h-7 w-7" />
              )}
            </div>
          )}
        </button>
        <div className="absolute left-2 top-2">
          <Checkbox
            checked={selected}
            onPointerDown={(event) => {
              shiftPressedRef.current = event.shiftKey
            }}
            onKeyDown={(event) => {
              shiftPressedRef.current = event.shiftKey
            }}
            onCheckedChange={() => {
              onSelect(item, { shiftKey: shiftPressedRef.current })
              shiftPressedRef.current = false
            }}
          />
        </div>
      </div>

      <div className="space-y-1 p-3">
        <p className="truncate text-sm font-medium" title={item.key}>
          {getDisplayName(item.key)}
        </p>
        <p className="text-xs text-muted-foreground">
          {item.isFolder
            ? `${typeof item.fileCount === "number" ? item.fileCount : 0} ${item.fileCount === 1 ? "file" : "files"} • ${formatDate(item.lastModified)}`
            : `${formatSize(item.size)} • ${formatDate(item.lastModified)}`}
        </p>
        <div className="flex items-center gap-1 pt-1">
          {item.isFolder ? (
            <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => onNavigate(item)}>
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => onDownload(item)}>
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {!readOnly && (
            <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => onDelete(item)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function GalleryBrowser({
  items,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  selectedKeys,
  credentialId,
  bucket,
  getItemSelectionKey,
  getItemCredentialId,
  getItemBucket,
  onSelect,
  onSelectAllVisible,
  onNavigate,
  onOpenPreview,
  onDownload,
  onDelete,
  onLoadMore,
  readOnly,
}: GalleryBrowserProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const shiftPressedRef = useRef(false)

  useEffect(() => {
    if (!hasNextPage) return
    if (isFetchingNextPage) return
    const target = sentinelRef.current
    if (!target) return

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries
        if (!entry?.isIntersecting) return
        onLoadMore()
      },
      { rootMargin: "300px" }
    )

    observer.observe(target)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, onLoadMore])

  const allVisibleSelected = useMemo(
    () =>
      items.length > 0 &&
      items.every((item) => selectedKeys.has(getItemSelectionKey?.(item) ?? item.key)),
    [items, selectedKeys, getItemSelectionKey]
  )

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, index) => (
          <div key={index} className="h-56 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState type="no-files" />
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <Checkbox checked={allVisibleSelected} onCheckedChange={onSelectAllVisible} />
        <span className="text-sm text-muted-foreground">
          Select all visible ({items.length})
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
        {items.map((item) => (
          <GalleryItemCard
            key={item.id}
            item={item}
            selected={selectedKeys.has(getItemSelectionKey?.(item) ?? item.key)}
            credentialId={credentialId}
            bucket={bucket}
            getItemCredentialId={getItemCredentialId}
            getItemBucket={getItemBucket}
            shiftPressedRef={shiftPressedRef}
            onSelect={onSelect}
            onNavigate={onNavigate}
            onOpenPreview={onOpenPreview}
            onDownload={onDownload}
            onDelete={onDelete}
            readOnly={readOnly}
          />
        ))}
      </div>

      <div ref={sentinelRef} className="flex h-16 items-center justify-center">
        {isFetchingNextPage ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading more...
          </div>
        ) : !hasNextPage ? (
          <span className="text-xs text-muted-foreground">End of results</span>
        ) : null}
      </div>
    </div>
  )
}
