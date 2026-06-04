"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { FileBrowser } from "@/components/dashboard/file-browser"
import { GalleryBrowser } from "@/components/dashboard/gallery-browser"
import { GalleryLightbox } from "@/components/dashboard/gallery-lightbox"
import { MultiSelectToolbar } from "@/components/dashboard/multi-select-toolbar"
import { DeleteConfirmDialog } from "@/components/dashboard/delete-confirm-dialog"
import { RenameDialog } from "@/components/dashboard/rename-dialog"
import { SearchFilters } from "@/components/dashboard/search-filters"
import { getPreviewType } from "@/lib/media"
import type { MediaType, PreviewType, S3Object } from "@/types"

interface SearchResult {
  id: string
  key: string
  bucket: string
  credentialId: string
  extension: string
  mediaType: MediaType | null
  previewUrl: string | null
  isVideo: boolean
  size: number
  lastModified: string
}

interface SearchResponse {
  results: SearchResult[]
  total: number
}

interface SearchItem extends S3Object {
  id: string
  bucket: string
  credentialId: string
  extension: string
  mediaType: MediaType | null
  previewType: PreviewType | null
  previewUrl: string | null
  isVideo: boolean
}

interface Bucket {
  name: string
  credentialId: string
}

interface Credential {
  id: string
  label: string
}

const PAGE_SIZE = 100
const MIN_QUERY_LENGTH = 2
const GLOBAL_SEARCH_VIEW_MODE_STORAGE_KEY = "global-search-view-mode"

function rowId(item: SearchItem): string {
  return item.id
}

function toSearchItem(result: SearchResult): SearchItem {
  return {
    id: result.id,
    key: result.key,
    size: result.size,
    lastModified: result.lastModified,
    isFolder: false,
    bucket: result.bucket,
    credentialId: result.credentialId,
    extension: result.extension,
    mediaType: result.mediaType,
    previewType: getPreviewType(result.extension),
    previewUrl: result.previewUrl,
    isVideo: result.isVideo,
  }
}

function getFilename(key: string): string {
  const parts = key.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? key
}

function getPathOnly(key: string): string {
  const normalized = key.endsWith("/") ? key.slice(0, -1) : key
  const separatorIndex = normalized.lastIndexOf("/")
  if (separatorIndex === -1) return "/"
  return `${normalized.slice(0, separatorIndex + 1)}`
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return Boolean(target.closest("input, textarea, [contenteditable='true']"))
}

export function GlobalSearch() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const [query, setQuery] = useState("")
  const [selectedBucketScopes, setSelectedBucketScopes] = useState<string[]>([])
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<string[]>([])
  const [selectedType, setSelectedType] = useState<string>("all")
  const [sortBy, setSortBy] = useState<"name" | "size" | "lastModified">("name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [viewMode, setViewMode] = useState<"list" | "gallery">(() => {
    if (typeof window === "undefined") return "list"
    const saved = window.localStorage.getItem(GLOBAL_SEARCH_VIEW_MODE_STORAGE_KEY)
    return saved === "gallery" ? "gallery" : "list"
  })

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [isBulkRunning, setIsBulkRunning] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteItems, setDeleteItems] = useState<SearchItem[]>([])
  const [deleteContext, setDeleteContext] = useState<{
    bucket: string
    credentialId: string
  } | null>(null)

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<SearchItem | null>(null)

  const selectionAnchorRef = useRef<string | null>(null)

  const { data: credentials = [] } = useQuery<Credential[]>({
    queryKey: ["credentials"],
    queryFn: async () => {
      const res = await fetch("/api/s3/credentials")
      if (!res.ok) return []
      return res.json()
    },
  })

  const { data: buckets = [] } = useQuery<Bucket[]>({
    queryKey: ["buckets"],
    queryFn: async () => {
      const res = await fetch("/api/s3/buckets?all=true")
      if (!res.ok) return []
      const data = await res.json()
      return data.buckets ?? []
    },
  })

  const credentialsById = useMemo(
    () => new Map(credentials.map((credential) => [credential.id, credential.label])),
    [credentials]
  )

  const filteredBucketScopes = useMemo(() => {
    const seen = new Set<string>()
    const result: Bucket[] = []

    for (const bucket of buckets) {
      if (
        selectedCredentialIds.length > 0 &&
        !selectedCredentialIds.includes(bucket.credentialId)
      ) {
        continue
      }

      const scope = `${bucket.credentialId}::${bucket.name}`
      if (seen.has(scope)) continue
      seen.add(scope)
      result.push(bucket)
    }

    return result
  }, [buckets, selectedCredentialIds])

  const queryValue = query.trim()

  const resetSelection = () => {
    setSelectedKeys(new Set())
    selectionAnchorRef.current = null
  }

  const buildSearchParams = (skip = 0, take = PAGE_SIZE) => {
    const params = new URLSearchParams()
    params.set("q", queryValue)
    params.set("type", selectedType)
    params.set("sortBy", sortBy)
    params.set("sortDir", sortDir)
    params.set("skip", String(skip))
    params.set("take", String(take))

    if (selectedCredentialIds.length > 0) {
      params.set("credentialIds", selectedCredentialIds.join(","))
    }

    for (const scope of selectedBucketScopes) {
      params.append("scope", scope)
    }

    return params
  }

  const fetchSearchPage = async (skip = 0, take = PAGE_SIZE): Promise<SearchResponse> => {
    if (queryValue.length < MIN_QUERY_LENGTH) {
      return { results: [], total: 0 }
    }

    const params = buildSearchParams(skip, take)
    const res = await fetch(`/api/s3/search?${params}`)
    if (!res.ok) {
      throw new Error("Search failed")
    }

    const data = (await res.json()) as SearchResponse
    return {
      results: data.results ?? [],
      total: Number(data.total ?? 0),
    }
  }

  const { data: searchData, isLoading } = useQuery<SearchResponse>({
    queryKey: [
      "global-search",
      queryValue,
      selectedBucketScopes,
      selectedCredentialIds,
      selectedType,
      sortBy,
      sortDir,
      PAGE_SIZE,
    ],
    queryFn: () => fetchSearchPage(0, PAGE_SIZE),
    enabled: queryValue.length >= MIN_QUERY_LENGTH,
  })

  const items = useMemo<SearchItem[]>(
    () => (searchData?.results ?? []).map((result) => toSearchItem(result)),
    [searchData]
  )

  const visibleRowIds = useMemo(() => items.map((item) => rowId(item)), [items])

  const selectedItems = items.filter((item) => selectedKeys.has(rowId(item)))
  const selectedCount = selectedKeys.size
  const previewableGalleryItems = useMemo(
    () => items.filter((item) => !item.isFolder && Boolean(item.mediaType)),
    [items]
  )

  useEffect(() => {
    window.localStorage.setItem(GLOBAL_SEARCH_VIEW_MODE_STORAGE_KEY, viewMode)
  }, [viewMode])

  useEffect(() => {
    if (lightboxIndex === null) return
    if (lightboxIndex < 0 || lightboxIndex >= previewableGalleryItems.length) {
      setLightboxIndex(null)
    }
  }, [lightboxIndex, previewableGalleryItems.length])

  useEffect(() => {
    if (!selectionAnchorRef.current) return
    if (!visibleRowIds.includes(selectionAnchorRef.current)) {
      selectionAnchorRef.current = null
    }
  }, [visibleRowIds])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() !== "a") return
      if (isEditableTarget(event.target)) return

      event.preventDefault()

      if (visibleRowIds.length === 0) {
        setSelectedKeys(new Set())
        selectionAnchorRef.current = null
        return
      }

      setSelectedKeys(new Set(visibleRowIds))
      selectionAnchorRef.current = visibleRowIds[visibleRowIds.length - 1] ?? null
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [visibleRowIds])

  const toggleBucketScope = (scope: string) => {
    setSelectedBucketScopes((prev) =>
      prev.includes(scope) ? prev.filter((value) => value !== scope) : [...prev, scope]
    )
    resetSelection()
  }

  const toggleCredential = (credentialId: string) => {
    setSelectedCredentialIds((prev) =>
      prev.includes(credentialId)
        ? prev.filter((value) => value !== credentialId)
        : [...prev, credentialId]
    )
    resetSelection()
  }

  const resetResultsState = () => {
    resetSelection()
    queryClient.invalidateQueries({ queryKey: ["global-search"] })
    queryClient.invalidateQueries({ queryKey: ["bucket-stats"] })
    queryClient.invalidateQueries({ queryKey: ["objects"] })
  }

  const triggerBrowserDownload = (url: string, filename?: string) => {
    const link = document.createElement("a")
    link.href = url
    if (filename) {
      link.download = filename
    }
    link.rel = "noopener noreferrer"
    link.style.display = "none"
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const syncBucketAfterOperation = async (bucket: string, credentialId: string) => {
    const res = await fetch("/api/s3/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket, credentialId }),
    })

    if (!res.ok) {
      throw new Error("Sync failed")
    }
  }

  const handleDownload = async (item: SearchItem) => {
    try {
      const res = await fetch("/api/s3/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket: item.bucket,
          credentialId: item.credentialId,
          key: item.key,
        }),
      })

      if (!res.ok) {
        throw new Error("Failed to create download URL")
      }

      const { url, filename } = await res.json()
      triggerBrowserDownload(url, filename)
    } catch {
      toast.error(`Failed to download ${item.key}`)
    }
  }

  const handleBulkDownload = async () => {
    if (selectedItems.length === 0) return

    try {
      setIsBulkRunning(true)

      if (selectedItems.length > 50) {
        toast.info(`Starting ${selectedItems.length} downloads`)
      }

      for (const item of selectedItems) {
        await handleDownload(item)
      }
    } catch {
      toast.error("Failed to download selected files")
    } finally {
      setIsBulkRunning(false)
    }
  }

  const openDeleteDialog = (itemsToDelete: SearchItem[]) => {
    if (itemsToDelete.length === 0) return

    const first = itemsToDelete[0]
    const singleContext = itemsToDelete.every(
      (item) => item.bucket === first.bucket && item.credentialId === first.credentialId
    )

    if (!singleContext) {
      toast.error("Select files from a single bucket/account to delete together")
      return
    }

    setDeleteItems(itemsToDelete)
    setDeleteContext({ bucket: first.bucket, credentialId: first.credentialId })
    setDeleteOpen(true)
  }

  const handleBulkDelete = () => {
    openDeleteDialog(selectedItems)
  }

  const handleOpenInBucket = (item: SearchItem) => {
    const parts = item.key.split("/")
    const prefix = parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : ""

    const params = new URLSearchParams({
      bucket: item.bucket,
      credentialId: item.credentialId,
    })

    if (prefix) {
      params.set("prefix", prefix)
    }

    router.push(`/dashboard?${params}`)
  }

  const handleSelect = (item: SearchItem, options?: { shiftKey?: boolean }) => {
    const id = rowId(item)

    setSelectedKeys((prev) => {
      const next = new Set(prev)
      const shouldSelect = !prev.has(id)
      const anchorId = selectionAnchorRef.current

      if (options?.shiftKey && anchorId) {
        const anchorIndex = visibleRowIds.indexOf(anchorId)
        const currentIndex = visibleRowIds.indexOf(id)

        if (anchorIndex !== -1 && currentIndex !== -1) {
          const [start, end] =
            anchorIndex <= currentIndex
              ? [anchorIndex, currentIndex]
              : [currentIndex, anchorIndex]

          for (const rangeId of visibleRowIds.slice(start, end + 1)) {
            if (shouldSelect) {
              next.add(rangeId)
            } else {
              next.delete(rangeId)
            }
          }

          selectionAnchorRef.current = id
          return next
        }
      }

      if (shouldSelect) {
        next.add(id)
      } else {
        next.delete(id)
      }

      selectionAnchorRef.current = id
      return next
    })
  }

  const handleSelectAll = () => {
    setSelectedKeys((prev) => {
      if (visibleRowIds.length === 0) {
        selectionAnchorRef.current = null
        return new Set()
      }

      const allSelected = visibleRowIds.every((id) => prev.has(id))
      if (allSelected) {
        selectionAnchorRef.current = null
        return new Set()
      }

      selectionAnchorRef.current = visibleRowIds[visibleRowIds.length - 1] ?? null
      return new Set(visibleRowIds)
    })
  }

  return (
    <div className="flex h-full flex-col">
      <SearchFilters
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          resetSelection()
        }}
        credentials={credentials}
        selectedCredentialIds={selectedCredentialIds}
        onToggleCredential={toggleCredential}
        onClearCredentials={() => {
          setSelectedCredentialIds([])
          resetSelection()
        }}
        filteredBucketScopes={filteredBucketScopes}
        credentialsById={credentialsById}
        selectedBucketScopes={selectedBucketScopes}
        onToggleBucketScope={toggleBucketScope}
        onClearBucketScopes={() => {
          setSelectedBucketScopes([])
          resetSelection()
        }}
        selectedType={selectedType}
        onTypeChange={(type) => {
          setSelectedType(type)
          resetSelection()
        }}
        viewMode={viewMode}
        onViewModeChange={(mode) => {
          setViewMode(mode)
          resetSelection()
        }}
      />

      {selectedCount > 0 && (
        <MultiSelectToolbar
          selectedCount={selectedCount}
          onDelete={handleBulkDelete}
          onDownload={handleBulkDownload}
          onClear={resetSelection}
        />
      )}

      {queryValue.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Start typing to search across all buckets and accounts
        </div>
      ) : queryValue.length < MIN_QUERY_LENGTH ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Type at least {MIN_QUERY_LENGTH} characters to start searching
        </div>
      ) : isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Searching...
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No files found for {`"${queryValue}"`}
        </div>
      ) : viewMode === "gallery" ? (
        <GalleryBrowser
          items={items}
          isLoading={false}
          isFetchingNextPage={false}
          hasNextPage={false}
          selectedKeys={selectedKeys}
          getItemSelectionKey={(item) => rowId(item as SearchItem)}
          getItemBucket={(item) => (item as SearchItem).bucket}
          getItemCredentialId={(item) => (item as SearchItem).credentialId}
          onSelect={(item, options) => handleSelect(item as SearchItem, options)}
          onSelectAllVisible={handleSelectAll}
          onNavigate={(item) => handleOpenInBucket(item as SearchItem)}
          onOpenPreview={(item) => {
            const searchItem = item as SearchItem
            const index = previewableGalleryItems.findIndex((entry) => entry.id === searchItem.id)
            if (index >= 0) {
              setLightboxIndex(index)
              return
            }
            void handleDownload(searchItem)
          }}
          onDownload={(item) => void handleDownload(item as SearchItem)}
          onDelete={(item) => openDeleteDialog([item as SearchItem])}
          onLoadMore={() => {}}
        />
      ) : (
        <FileBrowser
          prefix=""
          files={items}
          isLoading={false}
          selectedKeys={selectedKeys}
          onSelect={(item, options) => handleSelect(item as SearchItem, options)}
          onSelectAll={handleSelectAll}
          onNavigate={(item) => handleOpenInBucket(item as SearchItem)}
          onRename={(item) => {
            setRenameTarget(item as SearchItem)
            setRenameOpen(true)
          }}
          onDelete={(item) => openDeleteDialog([item as SearchItem])}
          onDownload={(item) => handleDownload(item as SearchItem)}
          getRowId={(item) => rowId(item as SearchItem)}
          getNameLabel={(item) => getFilename((item as SearchItem).key)}
          pathHeader="Path"
          getPathLabel={(item) => getPathOnly((item as SearchItem).key)}
          compact
          locationHeader="Bucket / Account"
          getLocationLabel={(item) => {
            const row = item as SearchItem
            const credentialLabel = credentialsById.get(row.credentialId) ?? "Unknown"
            return `${row.bucket} · ${credentialLabel}`
          }}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={(column) => {
            setSortBy((currentSortBy) => {
              if (currentSortBy === column) {
                setSortDir((currentSortDir) => (currentSortDir === "asc" ? "desc" : "asc"))
                return currentSortBy
              }
              setSortDir("asc")
              return column
            })
            resetSelection()
          }}
        />
      )}

      <GalleryLightbox
        open={lightboxIndex !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxIndex(null)
        }}
        items={previewableGalleryItems}
        currentIndex={lightboxIndex ?? 0}
        getItemBucket={(item) => (item as SearchItem).bucket}
        getItemCredentialId={(item) => (item as SearchItem).credentialId}
        onNavigate={(index) => setLightboxIndex(index)}
        onDownload={(item) => void handleDownload(item as unknown as SearchItem)}
      />

      {deleteContext && (
        <DeleteConfirmDialog
          open={deleteOpen}
          onOpenChange={(open) => {
            setDeleteOpen(open)
            if (!open) {
              setDeleteItems([])
              setDeleteContext(null)
            }
          }}
          items={deleteItems}
          bucket={deleteContext.bucket}
          credentialId={deleteContext.credentialId}
          onDeleteComplete={async () => {
            try {
              await syncBucketAfterOperation(deleteContext.bucket, deleteContext.credentialId)
            } catch {
              toast.error("Delete completed, but bucket sync failed")
            }
            setDeleteItems([])
            setDeleteContext(null)
            resetResultsState()
          }}
        />
      )}

      {renameTarget && (
        <RenameDialog
          open={renameOpen}
          onOpenChange={(open) => {
            setRenameOpen(open)
            if (!open) {
              setRenameTarget(null)
            }
          }}
          bucket={renameTarget.bucket}
          credentialId={renameTarget.credentialId}
          currentKey={renameTarget.key}
          isFolder={renameTarget.isFolder}
          onRenameComplete={async () => {
            try {
              await syncBucketAfterOperation(renameTarget.bucket, renameTarget.credentialId)
            } catch {
              toast.error("Rename completed, but bucket sync failed")
            }
            resetResultsState()
          }}
        />
      )}

      {isBulkRunning && (
        <div className="pointer-events-none fixed bottom-4 right-4 rounded-md border bg-background px-3 py-2 text-sm shadow">
          Processing downloads...
        </div>
      )}
    </div>
  )
}
