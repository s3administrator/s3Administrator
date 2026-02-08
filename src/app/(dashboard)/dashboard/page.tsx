"use client"

import { useSearchParams, useRouter } from "next/navigation"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, useCallback, Suspense } from "react"
import { Topbar } from "@/components/dashboard/topbar"
import { FileBrowser } from "@/components/dashboard/file-browser"
import { MultiSelectToolbar } from "@/components/dashboard/multi-select-toolbar"
import { UploadDialog } from "@/components/dashboard/upload-dialog"
import { DeleteConfirmDialog } from "@/components/dashboard/delete-confirm-dialog"
import { RenameDialog } from "@/components/dashboard/rename-dialog"
import { NewFolderDialog } from "@/components/dashboard/new-folder-dialog"
import { DashboardOverview } from "@/components/dashboard/dashboard-overview"
import { EmptyState } from "@/components/dashboard/empty-state"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { S3Object } from "@/types"

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

function DashboardContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const queryClient = useQueryClient()

  const bucket = searchParams.get("bucket") || ""
  const prefix = searchParams.get("prefix") || ""
  const credentialId = searchParams.get("credentialId") || undefined

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<"name" | "size" | "lastModified">("name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const [uploadOpen, setUploadOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderMoveItems, setNewFolderMoveItems] = useState<S3Object[] | null>(null)
  const [moveProgress, setMoveProgress] = useState<MoveProgressState | null>(null)
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
  })

  const allItems = [...(data?.folders ?? []), ...(data?.files ?? [])]

  const filteredItems = searchQuery
    ? allItems.filter((item) =>
        item.key.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : allItems

  const sortedItems = [...filteredItems].sort((a, b) => {
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
  })

  const invalidateBucketQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["objects"] })
    queryClient.invalidateQueries({ queryKey: ["bucket-stats"] })
    setSelectedKeys(new Set())
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

  function handleNavigate(folderKey: string) {
    const params = new URLSearchParams({ bucket })
    if (folderKey) params.set("prefix", folderKey)
    if (credentialId) params.set("credentialId", credentialId)
    router.push(`/dashboard?${params}`)
    setSelectedKeys(new Set())
  }

  function handleSelect(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleSelectAll() {
    if (selectedKeys.size === sortedItems.length) {
      setSelectedKeys(new Set())
    } else {
      setSelectedKeys(new Set(sortedItems.map((item) => item.key)))
    }
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

  const selectedItems = sortedItems.filter((item) =>
    selectedKeys.has(item.key)
  )

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

    try {
      const moved = await moveItemsToFolder(itemsToMove, destinationFolder.key)
      startSyncProgress(destinationFolder.key)
      await handleBucketOperationComplete()
      toast.success(`Moved ${moved} item(s)`)
      setNewFolderMoveItems(null)
    } catch (error) {
      startSyncProgress(destinationFolder.key)
      await handleBucketOperationComplete()
      const message = error instanceof Error ? error.message : "Failed to move selected items"
      toast.error(message)
    } finally {
      setMoveProgress(null)
    }
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
      />

      {selectedKeys.size > 0 && (
        <MultiSelectToolbar
          selectedCount={selectedKeys.size}
          onDelete={() => setDeleteOpen(true)}
          onDownload={() => handleDownload(Array.from(selectedKeys))}
          onCreateFolder={() => {
            setNewFolderMoveItems(selectedItems)
            setNewFolderOpen(true)
          }}
          onMoveToSelectedFolder={() => {
            if (!moveProgress) {
              void handleMoveToSelectedFolder()
            }
          }}
          onClear={() => setSelectedKeys(new Set())}
        />
      )}

      <FileBrowser
        prefix={prefix}
        files={sortedItems}
        isLoading={isLoading}
        selectedKeys={selectedKeys}
        onSelect={(file) => handleSelect(file.key)}
        onSelectAll={handleSelectAll}
        onNavigate={(file) => handleNavigate(file.key)}
        onRename={(file) => handleRename(file.key, file.isFolder)}
        onDelete={(file) => {
          setSelectedKeys(new Set([file.key]))
          setDeleteOpen(true)
        }}
        onDownload={(file) => handleDownload([file.key])}
      />

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
            try {
              const moved = await moveItemsToFolder(newFolderMoveItems, createdFolderKey)
              startSyncProgress(createdFolderKey)
              await handleBucketOperationComplete()
              toast.success(`Moved ${moved} item(s) to ${getBaseNameFromKey(createdFolderKey, true)}`)
            } catch (error) {
              startSyncProgress(createdFolderKey)
              await handleBucketOperationComplete()
              const message = error instanceof Error ? error.message : "Failed to move selected items"
              toast.error(message)
            } finally {
              setMoveProgress(null)
            }
          } else {
            await handleBucketOperationComplete()
          }

          setNewFolderMoveItems(null)
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
