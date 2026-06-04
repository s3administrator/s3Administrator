"use client"

import { useSearchParams, useRouter } from "next/navigation"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, useCallback, Suspense, useMemo, useEffect, useRef } from "react"
import { Topbar } from "@/components/dashboard/topbar"
import { FileBrowser } from "@/components/dashboard/file-browser"
import { GalleryBrowser } from "@/components/dashboard/gallery-browser"
import { GalleryLightbox } from "@/components/dashboard/gallery-lightbox"
import { FilePreviewDialog } from "@/components/dashboard/file-preview-dialog"
import { getPreviewType } from "@/lib/media"
import { MultiSelectToolbar } from "@/components/dashboard/multi-select-toolbar"
import { UploadDialog } from "@/components/dashboard/upload-dialog"
import { DeleteConfirmDialog } from "@/components/dashboard/delete-confirm-dialog"
import { RenameDialog } from "@/components/dashboard/rename-dialog"
import { NewFolderDialog } from "@/components/dashboard/new-folder-dialog"
import { DestructiveConfirmDialog } from "@/components/shared/destructive-confirm-dialog"
import { DashboardOverview } from "@/components/dashboard/dashboard-overview"
import { EmptyState } from "@/components/dashboard/empty-state"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  DESTRUCTIVE_CONFIRM_SCOPE,
  hasDestructiveConfirmBypass,
} from "@/lib/destructive-confirmation"
import type { GalleryResponse, S3Object } from "@/types"

interface MoveOperation {
  from: string
  to: string
  label: string
}

interface MoveProgressState {
  stage: "moving" | "syncing"
  destinationLabel: string
  total: number
  completed: number
  currentLabel: string
}

interface Credential {
  id: string
}

interface BucketRef {
  name: string
  credentialId: string
}

function getBaseNameFromKey(key: string, isFolder: boolean): string {
  const normalized = isFolder && key.endsWith("/") ? key.slice(0, -1) : key
  const parts = normalized.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? normalized
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return Boolean(target.closest("input, textarea, [contenteditable='true']"))
}

function DashboardContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const queryClient = useQueryClient()

  const bucket = searchParams.get("bucket") || ""
  const prefix = searchParams.get("prefix") || ""
  const credentialId = searchParams.get("credentialId") || undefined

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<"name" | "size" | "lastModified">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("s3admin:sortBy")
      if (saved === "name" || saved === "size" || saved === "lastModified") return saved
    }
    return "name"
  })
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("s3admin:sortDir")
      if (saved === "asc" || saved === "desc") return saved
    }
    return "asc"
  })
  const [viewMode, setViewMode] = useState<"list" | "gallery">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("s3admin:viewMode")
      if (saved === "list" || saved === "gallery") return saved
    }
    return "list"
  })
  const [showVersions, setShowVersions] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const selectionAnchorRef = useRef<string | null>(null)

  const [uploadOpen, setUploadOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderMoveItems, setNewFolderMoveItems] = useState<S3Object[] | null>(null)
  const [moveProgress, setMoveProgress] = useState<MoveProgressState | null>(null)
  const [moveConfirmOpen, setMoveConfirmOpen] = useState(false)
  const [pendingMoveAction, setPendingMoveAction] = useState<(() => Promise<void>) | null>(null)
  const [previewFile, setPreviewFile] = useState<S3Object | null>(null)
  const [renameTarget, setRenameTarget] = useState<{
    key: string
    isFolder: boolean
  } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ["objects", bucket, prefix, credentialId],
    queryFn: async () => {
      if (!bucket) return { folders: [], files: [] }
      const params = new URLSearchParams({ bucket })
      if (prefix) params.set("prefix", prefix)
      if (credentialId) params.set("credentialId", credentialId)
      const res = await fetch(`/api/s3/objects?${params}`)
      if (!res.ok) throw new Error("Failed to load objects")
      return res.json() as Promise<{ folders: S3Object[]; files: S3Object[] }>
    },
    enabled: !!bucket,
  })

  const {
    data: galleryData,
    isLoading: galleryLoading,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
  } = useInfiniteQuery<GalleryResponse>({
    queryKey: ["gallery", bucket, prefix, credentialId],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const cursor = typeof pageParam === "string" ? pageParam : null
      const params = new URLSearchParams({
        bucket,
        limit: "25",
        mediaType: "all",
      })
      if (prefix) params.set("prefix", prefix)
      if (credentialId) params.set("credentialId", credentialId)
      if (cursor) params.set("cursor", cursor)
      const res = await fetch(`/api/s3/gallery?${params}`)
      if (!res.ok) throw new Error("Failed to load gallery")
      return res.json() as Promise<GalleryResponse>
    },
    getNextPageParam: (lastPage) => (lastPage.nextCursor ? lastPage.nextCursor : undefined),
    enabled: !!bucket && viewMode === "gallery",
  })

  const { data: credentials = [], isLoading: credentialsLoading } = useQuery<Credential[]>({
    queryKey: ["credentials"],
    queryFn: async () => {
      const res = await fetch("/api/s3/credentials")
      if (!res.ok) return []
      return res.json()
    },
    enabled: !bucket,
  })

  const { data: availableBuckets = [], isLoading: bucketsLoading } = useQuery<BucketRef[]>({
    queryKey: ["buckets"],
    queryFn: async () => {
      const res = await fetch("/api/s3/buckets?all=true")
      if (!res.ok) return []
      const payload = await res.json()
      return (payload?.buckets ?? []) as BucketRef[]
    },
    enabled: !bucket,
    retry: false,
  })

  // Check versioning status for the current bucket
  const { data: bucketSettings } = useQuery<{
    settings: { versioning: { status: string } }
  }>({
    queryKey: ["bucket-settings", credentialId ?? "", bucket],
    queryFn: async () => {
      const params = new URLSearchParams({ bucket })
      if (credentialId) params.set("credentialId", credentialId)
      const res = await fetch(`/api/s3/bucket-settings?${params}`)
      if (!res.ok) return { settings: { versioning: { status: "unversioned" } } }
      return res.json()
    },
    enabled: !!bucket,
  })

  const versioningEnabled =
    bucketSettings?.settings?.versioning?.status === "enabled" ||
    bucketSettings?.settings?.versioning?.status === "suspended"

  // Fetch versions when toggle is on
  interface VersionsListResponse {
    versions: {
      key: string
      versionId: string
      size: number
      lastModifiedUtc: string
      isLatest: boolean
      isDeleteMarker: boolean
    }[]
    pagination: { hasMore: boolean }
  }

  const { data: versionsData, refetch: refetchVersions } = useQuery<VersionsListResponse>({
    queryKey: ["versions-list", bucket, prefix, credentialId],
    queryFn: async () => {
      const params = new URLSearchParams({ bucket, limit: "500" })
      if (prefix) params.set("prefix", prefix)
      if (credentialId) params.set("credentialId", credentialId)
      const res = await fetch(`/api/s3/versions/list?${params}`)
      if (!res.ok) throw new Error("Failed to load versions")
      return res.json() as Promise<VersionsListResponse>
    },
    enabled: !!bucket && showVersions && versioningEnabled,
  })

  const allItems = useMemo(() => {
    const base: S3Object[] = [...(data?.folders ?? []), ...(data?.files ?? [])]
    if (!showVersions || !versionsData?.versions) return base

    // Add non-current versions and delete markers as extra rows
    const extraItems: S3Object[] = []
    for (const v of versionsData.versions) {
      if (v.isLatest && !v.isDeleteMarker) continue // current version already in base list
      extraItems.push({
        key: v.key,
        size: v.size,
        lastModified: v.lastModifiedUtc,
        isFolder: false,
        versionId: v.versionId,
        isLatest: v.isLatest,
        isDeleteMarker: v.isDeleteMarker,
      })
    }

    // Mark base files with isLatest for visual distinction
    const withVersionInfo = base.map((item) => {
      if (item.isFolder) return item
      const currentVersion = versionsData.versions.find(
        (v) => v.key === item.key && v.isLatest && !v.isDeleteMarker
      )
      if (currentVersion) {
        return { ...item, versionId: currentVersion.versionId, isLatest: true }
      }
      return item
    })

    return [...withVersionInfo, ...extraItems]
  }, [data?.files, data?.folders, showVersions, versionsData])

  const galleryItems = useMemo(
    () => galleryData?.pages.flatMap((page) => page.items) ?? [],
    [galleryData?.pages]
  )

  const filteredItems = useMemo(() => {
    if (!searchQuery) return allItems
    return allItems.filter((item) =>
      item.key.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [allItems, searchQuery])

  const sortedItems = useMemo(() => [...filteredItems].sort((a, b) => {
    if (a.isFolder && !b.isFolder) return -1
    if (!a.isFolder && b.isFolder) return 1

    let cmp = 0
    if (sortBy === "name") {
      cmp = a.key.localeCompare(b.key)
    } else if (sortBy === "size") {
      cmp = a.size - b.size
    } else {
      cmp =
        new Date(a.lastModified).getTime() -
        new Date(b.lastModified).getTime()
    }
    return sortDir === "asc" ? cmp : -cmp
  }), [filteredItems, sortBy, sortDir])

  const filteredGalleryItems = useMemo(() => {
    if (!searchQuery) return galleryItems
    return galleryItems.filter((item) =>
      item.key.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [galleryItems, searchQuery])

  const sortedGalleryItems = useMemo(() => [...filteredGalleryItems].sort((a, b) => {
    if (a.isFolder && !b.isFolder) return -1
    if (!a.isFolder && b.isFolder) return 1

    let cmp = 0
    if (sortBy === "name") {
      cmp = a.key.localeCompare(b.key)
    } else if (sortBy === "size") {
      cmp = a.size - b.size
    } else {
      cmp =
        new Date(a.lastModified).getTime() -
        new Date(b.lastModified).getTime()
    }
    return sortDir === "asc" ? cmp : -cmp
  }), [filteredGalleryItems, sortBy, sortDir])

  const visibleSelectionKeys = useMemo(
    () =>
      viewMode === "gallery"
        ? sortedGalleryItems.map((item) => item.key)
        : sortedItems.map((item) => item.key),
    [sortedGalleryItems, sortedItems, viewMode]
  )


  const lightboxItems = useMemo(
    () => sortedGalleryItems.filter((item) => !item.isFolder && Boolean(item.mediaType)),
    [sortedGalleryItems]
  )

  const handleDeleteVersion = useCallback(
    async (key: string, versionId: string) => {
      try {
        const res = await fetch("/api/s3/versions/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, credentialId, key, versionId }),
        })
        if (!res.ok) {
          const payload = await res.json().catch(() => null)
          throw new Error(payload?.error ?? "Failed to delete version")
        }
        toast.success("Version deleted")
        void refetchVersions()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to delete version")
      }
    },
    [bucket, credentialId, refetchVersions]
  )

  const invalidateBucketQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["objects"] })
    queryClient.invalidateQueries({ queryKey: ["gallery"] })
    queryClient.invalidateQueries({ queryKey: ["bucket-stats"] })
    setSelectedKeys(new Set())
    selectionAnchorRef.current = null
  }, [queryClient])

  const syncCurrentBucket = useCallback(
    async (showToast = false) => {
      if (!bucket) return

      const res = await fetch("/api/s3/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket, credentialId }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error ?? "Sync failed")
      }

      invalidateBucketQueries()

      if (showToast) {
        toast.success(`Synced ${data?.synced ?? 0} files`)
      }
    },
    [bucket, credentialId, invalidateBucketQueries]
  )

  const handleBucketOperationComplete = useCallback(async () => {
    try {
      await syncCurrentBucket(false)
    } catch {
      invalidateBucketQueries()
      toast.error("Operation completed, but bucket sync failed")
    }
  }, [syncCurrentBucket, invalidateBucketQueries])

  useEffect(() => {
    localStorage.setItem("s3admin:viewMode", viewMode)
  }, [viewMode])

  useEffect(() => {
    localStorage.setItem("s3admin:sortBy", sortBy)
  }, [sortBy])

  useEffect(() => {
    localStorage.setItem("s3admin:sortDir", sortDir)
  }, [sortDir])

  useEffect(() => {
    setSelectedKeys(new Set())
    setLightboxIndex(null)
    setPreviewFile(null)
    selectionAnchorRef.current = null
  }, [bucket, prefix, credentialId, viewMode])


  useEffect(() => {
    if (!selectionAnchorRef.current) return
    if (!visibleSelectionKeys.includes(selectionAnchorRef.current)) {
      selectionAnchorRef.current = null
    }
  }, [visibleSelectionKeys])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() !== "a") return
      if (isEditableTarget(event.target)) return
      if (
        uploadOpen ||
        deleteOpen ||
        renameOpen ||
        newFolderOpen ||
        moveConfirmOpen ||
        lightboxIndex !== null ||
        previewFile !== null
      ) {
        return
      }

      event.preventDefault()

      if (visibleSelectionKeys.length === 0) {
        setSelectedKeys(new Set())
        selectionAnchorRef.current = null
        return
      }

      setSelectedKeys(new Set(visibleSelectionKeys))
      selectionAnchorRef.current =
        visibleSelectionKeys[visibleSelectionKeys.length - 1] ?? null
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    visibleSelectionKeys,
    uploadOpen,
    deleteOpen,
    renameOpen,
    newFolderOpen,
    moveConfirmOpen,
    lightboxIndex,
    previewFile,
  ])

  function handleNavigate(folderKey: string) {
    const params = new URLSearchParams({ bucket })
    if (folderKey) params.set("prefix", folderKey)
    if (credentialId) params.set("credentialId", credentialId)
    router.push(`/dashboard?${params}`)
    setSelectedKeys(new Set())
    selectionAnchorRef.current = null
  }

  function handleSelect(key: string, options?: { shiftKey?: boolean }) {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      const shouldSelect = !prev.has(key)
      const anchorKey = selectionAnchorRef.current

      if (options?.shiftKey && anchorKey) {
        const anchorIndex = visibleSelectionKeys.indexOf(anchorKey)
        const currentIndex = visibleSelectionKeys.indexOf(key)

        if (anchorIndex !== -1 && currentIndex !== -1) {
          const [start, end] =
            anchorIndex <= currentIndex
              ? [anchorIndex, currentIndex]
              : [currentIndex, anchorIndex]

          for (const rangeKey of visibleSelectionKeys.slice(start, end + 1)) {
            if (shouldSelect) {
              next.add(rangeKey)
            } else {
              next.delete(rangeKey)
            }
          }

          selectionAnchorRef.current = key
          return next
        }
      }

      if (shouldSelect) {
        next.add(key)
      } else {
        next.delete(key)
      }

      selectionAnchorRef.current = key
      return next
    })
  }

  function handleSelectAll() {
    setSelectedKeys((prev) => {
      if (visibleSelectionKeys.length === 0) {
        selectionAnchorRef.current = null
        return new Set()
      }

      const allSelected = visibleSelectionKeys.every((key) => prev.has(key))
      if (allSelected) {
        selectionAnchorRef.current = null
        return new Set()
      }

      selectionAnchorRef.current =
        visibleSelectionKeys[visibleSelectionKeys.length - 1] ?? null
      return new Set(visibleSelectionKeys)
    })
  }

  function handleSort(column: "name" | "size" | "lastModified") {
    if (sortBy === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(column)
      setSortDir("asc")
    }
  }

  function handleRename(key: string, isFolder: boolean) {
    setRenameTarget({ key, isFolder })
    setRenameOpen(true)
  }

  function triggerBrowserDownload(url: string, filename?: string) {
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

  async function handleDownload(keys: string[]) {
    for (const key of keys) {
      try {
        const res = await fetch("/api/s3/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, credentialId, key }),
        })
        if (!res.ok) throw new Error("Failed to create download URL")

        const { url, filename } = await res.json()
        triggerBrowserDownload(url, filename)
      } catch {
        toast.error(`Failed to download ${key}`)
      }
    }
  }

  function handlePreview(file: S3Object) {
    if (file.isFolder) return

    const ext = file.key.includes(".")
      ? file.key.slice(file.key.lastIndexOf(".") + 1)
      : ""
    const type = getPreviewType(ext)

    if (!type) {
      void handleDownload([file.key])
      return
    }

    if (type === "image" || type === "video") {
      void handleDownload([file.key])
      return
    }

    setPreviewFile(file)
  }

  if (!bucket) {
    if (credentialsLoading || bucketsLoading) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )
    }

    if (credentials.length === 0) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <EmptyState type="no-credentials" />
        </div>
      )
    }

    if (availableBuckets.length === 0) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <EmptyState type="no-buckets" />
        </div>
      )
    }

    return (
      <DashboardOverview />
    )
  }

  const selectedItems: S3Object[] = viewMode === "gallery"
    ? sortedGalleryItems
      .filter((item) => selectedKeys.has(item.key))
      .map((item) => ({
        key: item.key,
        size: item.size,
        lastModified: item.lastModified,
        isFolder: item.isFolder,
        fileCount: item.fileCount,
        totalSize: item.totalSize,
      }))
    : sortedItems.filter((item) => selectedKeys.has(item.key))

  function buildMoveOperations(items: S3Object[], destinationFolderKey: string): MoveOperation[] {
    const itemsToMove = items.filter((item) => item.key !== destinationFolderKey)

    const invalidMove = itemsToMove.find(
      (item) => item.isFolder && destinationFolderKey.startsWith(item.key)
    )
    if (invalidMove) {
      throw new Error("A folder cannot be moved into itself")
    }

    return itemsToMove.map((item) => {
      const baseName = getBaseNameFromKey(item.key, item.isFolder)
      return {
        from: item.key,
        to: `${destinationFolderKey}${baseName}${item.isFolder ? "/" : ""}`,
        label: baseName,
      }
    })
  }

  async function moveOperationsWithProgress(
    operations: MoveOperation[],
    destinationFolderKey: string
  ) {
    if (operations.length === 0) return 0

    const destinationLabel = getBaseNameFromKey(destinationFolderKey, true)
    let movedTotal = 0

    setMoveProgress({
      stage: "moving",
      destinationLabel,
      total: operations.length,
      completed: 0,
      currentLabel: operations[0]?.label ?? destinationLabel,
    })

    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]

      setMoveProgress((prev) =>
        prev
          ? {
            ...prev,
            stage: "moving",
            currentLabel: operation.label,
          }
          : prev
      )

      const res = await fetch("/api/s3/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket,
          credentialId,
          operations: [{ from: operation.from, to: operation.to }],
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error ?? "Move failed")
      }

      movedTotal += Number(data?.moved ?? 1)

      setMoveProgress((prev) =>
        prev
          ? {
            ...prev,
            completed: index + 1,
          }
          : prev
      )
    }

    return movedTotal
  }

  async function moveItemsToFolder(items: S3Object[], destinationFolderKey: string) {
    const operations = buildMoveOperations(items, destinationFolderKey)
    return moveOperationsWithProgress(operations, destinationFolderKey)
  }

  function startSyncProgress(destinationFolderKey: string) {
    setMoveProgress((prev) => ({
      stage: "syncing",
      destinationLabel: prev?.destinationLabel ?? getBaseNameFromKey(destinationFolderKey, true),
      total: prev?.total ?? 0,
      completed: prev?.total ?? 0,
      currentLabel: "Syncing bucket index",
    }))
  }

  async function executeMoveWorkflow(params: {
    items: S3Object[]
    destinationFolderKey: string
    successMessage: (moved: number) => string
  }) {
    const { items, destinationFolderKey, successMessage } = params

    try {
      const moved = await moveItemsToFolder(items, destinationFolderKey)
      startSyncProgress(destinationFolderKey)
      await handleBucketOperationComplete()
      toast.success(successMessage(moved))
      setNewFolderMoveItems(null)
    } catch (error) {
      startSyncProgress(destinationFolderKey)
      await handleBucketOperationComplete()
      const message = error instanceof Error ? error.message : "Failed to move selected items"
      toast.error(message)
    } finally {
      setMoveProgress(null)
    }
  }

  async function runMoveWithOptionalConfirm(action: () => Promise<void>) {
    if (hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)) {
      await action()
      return
    }

    setPendingMoveAction(() => action)
    setMoveConfirmOpen(true)
  }

  async function handleMoveToSelectedFolder() {
    if (moveProgress) return

    const selectedFolders = selectedItems.filter((item) => item.isFolder)

    if (selectedFolders.length !== 1) {
      toast.error("Select exactly one destination folder")
      return
    }

    const destinationFolder = selectedFolders[0]
    const itemsToMove = selectedItems.filter((item) => item.key !== destinationFolder.key)

    if (itemsToMove.length === 0) {
      toast.error("Select at least one item to move into the folder")
      return
    }

    await runMoveWithOptionalConfirm(() =>
      executeMoveWorkflow({
        items: itemsToMove,
        destinationFolderKey: destinationFolder.key,
        successMessage: (moved) => `Moved ${moved} item(s)`,
      })
    )
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar
        bucket={bucket}
        prefix={prefix}
        credentialId={credentialId}
        onSearch={setSearchQuery}
        onUpload={() => setUploadOpen(true)}
        onSync={() =>
          void syncCurrentBucket(true).catch(() => {
            toast.error("Sync failed")
          })
        }
        onCreateFolder={() => {
          setNewFolderMoveItems(null)
          setNewFolderOpen(true)
        }}
        onSort={handleSort}
        sortBy={sortBy}
        sortDir={sortDir}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        showVersions={showVersions}
        onShowVersionsChange={versioningEnabled ? setShowVersions : undefined}
      />

      {selectedKeys.size > 0 && (
        <MultiSelectToolbar
          selectedCount={selectedKeys.size}
          onDelete={() => setDeleteOpen(true)}
          onDownload={() => {
            if (viewMode !== "gallery") {
              void handleDownload(Array.from(selectedKeys))
              return
            }

            const fileKeys = sortedGalleryItems
              .filter((item) => selectedKeys.has(item.key) && !item.isFolder)
              .map((item) => item.key)

            if (fileKeys.length === 0) {
              toast.error("Select at least one file to download")
              return
            }

            void handleDownload(fileKeys)
          }}
          onCreateFolder={() => {
            setNewFolderMoveItems(selectedItems)
            setNewFolderOpen(true)
          }}
          onMoveToSelectedFolder={
            viewMode === "list"
              ? () => {
                if (!moveProgress) {
                  void handleMoveToSelectedFolder()
                }
              }
              : undefined
          }
          selectionHint={
            viewMode === "gallery"
              ? "Move-to-selected-folder is available in list mode."
              : undefined
          }
          onClear={() => {
            setSelectedKeys(new Set())
            selectionAnchorRef.current = null
          }}
        />
      )}

      {viewMode === "gallery" ? (
        <GalleryBrowser
          items={sortedGalleryItems}
          credentialId={credentialId ?? ""}
          bucket={bucket}
          isLoading={galleryLoading}
          isFetchingNextPage={isFetchingNextPage}
          hasNextPage={Boolean(hasNextPage)}
          selectedKeys={selectedKeys}
          onSelect={(item, options) => handleSelect(item.key, options)}
          onSelectAllVisible={handleSelectAll}
          onNavigate={(item) => {
            if (!item.isFolder) return
            handleNavigate(item.key)
          }}
          onOpenPreview={(item) => {
            if (item.isFolder) {
              handleNavigate(item.key)
              return
            }

            // Audio and document files → open FilePreviewDialog
            const ext = item.key.includes(".")
              ? item.key.slice(item.key.lastIndexOf(".") + 1)
              : ""
            const pType = getPreviewType(ext)
            if (!pType) {
              void handleDownload([item.key])
              return
            }

            // ODF files (odt, ods, odp) → download only (no preview support)
            if (pType === "odf") {
              void handleDownload([item.key])
              return
            }

            if (pType !== "image" && pType !== "video") {
              setPreviewFile({
                key: item.key,
                size: item.size,
                lastModified: item.lastModified,
                isFolder: false,
              })
              return
            }

            // Image/video files → open lightbox
            const index = lightboxItems.findIndex((entry) => entry.key === item.key)
            if (index >= 0) setLightboxIndex(index)
          }}
          onDownload={(item) => {
            if (item.isFolder) return
            void handleDownload([item.key])
          }}
          onDelete={(item) => {
            setSelectedKeys(new Set([item.key]))
            setDeleteOpen(true)
          }}
          onLoadMore={() => {
            if (!hasNextPage || isFetchingNextPage) return
            void fetchNextPage()
          }}
        />
      ) : (
        <FileBrowser
          prefix={prefix}
          files={sortedItems}
          isLoading={isLoading}
          selectedKeys={selectedKeys}
          onSelect={(file, options) => handleSelect(file.key, options)}
          onSelectAll={handleSelectAll}
          onNavigate={(file) => handleNavigate(file.key)}
          onRename={(file) => handleRename(file.key, file.isFolder)}
          onDelete={(file) => {
            setSelectedKeys(new Set([file.key]))
            setDeleteOpen(true)
          }}
          onDownload={(file) => handleDownload([file.key])}
          onPreview={handlePreview}
          showVersions={showVersions}
          onDeleteVersion={handleDeleteVersion}
        />
      )}

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        bucket={bucket}
        credentialId={credentialId}
        prefix={prefix}
        onUploadComplete={handleBucketOperationComplete}
      />

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        items={selectedItems}
        bucket={bucket}
        credentialId={credentialId}
        onDeleteComplete={handleBucketOperationComplete}
      />

      <GalleryLightbox
        open={lightboxIndex !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxIndex(null)
        }}
        items={lightboxItems}
        currentIndex={lightboxIndex ?? 0}
        bucket={bucket}
        credentialId={credentialId}
        onNavigate={(index) => setLightboxIndex(index)}
        onDownload={(item) => void handleDownload([item.key])}
      />

      {previewFile && (
        <FilePreviewDialog
          open={previewFile !== null}
          onOpenChange={(open) => {
            if (!open) setPreviewFile(null)
          }}
          fileKey={previewFile.key}
          fileName={getBaseNameFromKey(previewFile.key, false)}
          fileSize={previewFile.size}
          bucket={bucket}
          credentialId={credentialId}
          onDownload={() => {
            void handleDownload([previewFile.key])
          }}
        />
      )}

      {renameTarget && (
        <RenameDialog
          open={renameOpen}
          onOpenChange={(open) => {
            setRenameOpen(open)
            if (!open) setRenameTarget(null)
          }}
          bucket={bucket}
          credentialId={credentialId}
          currentKey={renameTarget.key}
          isFolder={renameTarget.isFolder}
          onRenameComplete={handleBucketOperationComplete}
        />
      )}

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open)
          if (!open) {
            setNewFolderMoveItems(null)
          }
        }}
        bucket={bucket}
        credentialId={credentialId}
        prefix={prefix}
        onCreateComplete={async (createdFolderKey) => {
          if (newFolderMoveItems && newFolderMoveItems.length > 0) {
            await runMoveWithOptionalConfirm(() =>
              executeMoveWorkflow({
                items: newFolderMoveItems,
                destinationFolderKey: createdFolderKey,
                successMessage: (moved) =>
                  `Moved ${moved} item(s) to ${getBaseNameFromKey(createdFolderKey, true)}`,
              })
            )
          } else {
            await handleBucketOperationComplete()
          }

          setNewFolderMoveItems(null)
        }}
      />

      <DestructiveConfirmDialog
        open={moveConfirmOpen}
        onOpenChange={(open) => {
          setMoveConfirmOpen(open)
          if (!open) {
            setPendingMoveAction(null)
          }
        }}
        title="Confirm move operation"
        description="Moving objects deletes them from the source location after copy."
        actionLabel="Move Objects"
        onConfirm={async () => {
          if (!pendingMoveAction) {
            throw new Error("Missing move action")
          }
          await pendingMoveAction()
          setPendingMoveAction(null)
        }}
      />

      {moveProgress && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 w-80 rounded-md border bg-background p-3 shadow">
          <p className="text-sm font-medium">
            {moveProgress.stage === "moving" ? "Moving items..." : "Updating bucket index..."}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {moveProgress.stage === "moving"
              ? `${moveProgress.completed}/${moveProgress.total} · ${moveProgress.currentLabel}`
              : `Destination: ${moveProgress.destinationLabel}`}
          </p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{
                width: `${moveProgress.total > 0
                  ? Math.max(
                    8,
                    Math.min(100, Math.round((moveProgress.completed / moveProgress.total) * 100))
                  )
                  : 100}%`,
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default function DashboardPage() {
  return (
    <Suspense>
      <DashboardContent />
    </Suspense>
  )
}
