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
import { EmptyState } from "@/components/dashboard/empty-state"
import { toast } from "sonner"
import type { S3Object } from "@/types"

function DashboardContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const queryClient = useQueryClient()

  const bucket = searchParams.get("bucket") || ""
  const prefix = searchParams.get("prefix") || ""

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState<"name" | "size" | "lastModified">("name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const [uploadOpen, setUploadOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{
    key: string
    isFolder: boolean
  } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ["objects", bucket, prefix],
    queryFn: async () => {
      if (!bucket) return { folders: [], files: [] }
      const params = new URLSearchParams({ bucket })
      if (prefix) params.set("prefix", prefix)
      const res = await fetch(`/api/s3/objects?${params}`)
      if (!res.ok) throw new Error("Failed to load objects")
      return res.json() as Promise<{ folders: S3Object[]; files: S3Object[] }>
    },
    enabled: !!bucket,
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

  const refreshFiles = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["objects", bucket, prefix] })
    setSelectedKeys(new Set())
  }, [queryClient, bucket, prefix])

  function handleNavigate(folderKey: string) {
    const params = new URLSearchParams({ bucket })
    if (folderKey) params.set("prefix", folderKey)
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

  async function handleDownload(keys: string[]) {
    for (const key of keys) {
      try {
        const res = await fetch("/api/s3/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, key }),
        })
        const { url } = await res.json()
        window.open(url, "_blank")
      } catch {
        toast.error(`Failed to download ${key}`)
      }
    }
  }

  if (!bucket) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState type="no-buckets" />
      </div>
    )
  }

  const selectedItems = sortedItems.filter((item) =>
    selectedKeys.has(item.key)
  )

  return (
    <div className="flex h-full flex-col">
      <Topbar
        bucket={bucket}
        prefix={prefix}
        onSearch={setSearchQuery}
        onUpload={() => setUploadOpen(true)}
        onSync={() => {
          fetch("/api/s3/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bucket }),
          })
            .then((res) => res.json())
            .then((data) => {
              toast.success(`Synced ${data.synced} files`)
              refreshFiles()
            })
            .catch(() => toast.error("Sync failed"))
        }}
        onCreateFolder={() => setNewFolderOpen(true)}
        onSort={handleSort}
        sortBy={sortBy}
        sortDir={sortDir}
      />

      {selectedKeys.size > 0 && (
        <MultiSelectToolbar
          selectedCount={selectedKeys.size}
          onDelete={() => setDeleteOpen(true)}
          onDownload={() => handleDownload(Array.from(selectedKeys))}
          onClear={() => setSelectedKeys(new Set())}
        />
      )}

      <FileBrowser
        bucket={bucket}
        prefix={prefix}
        files={sortedItems}
        isLoading={isLoading}
        selectedKeys={selectedKeys}
        onSelect={handleSelect}
        onSelectAll={handleSelectAll}
        onNavigate={handleNavigate}
        onRename={handleRename}
        onDelete={(key, isFolder) => {
          setSelectedKeys(new Set([key]))
          setDeleteOpen(true)
        }}
        onDownload={(key) => handleDownload([key])}
      />

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        bucket={bucket}
        prefix={prefix}
        onUploadComplete={refreshFiles}
      />

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        items={selectedItems}
        bucket={bucket}
        onDeleteComplete={refreshFiles}
      />

      {renameTarget && (
        <RenameDialog
          open={renameOpen}
          onOpenChange={(open) => {
            setRenameOpen(open)
            if (!open) setRenameTarget(null)
          }}
          bucket={bucket}
          currentKey={renameTarget.key}
          isFolder={renameTarget.isFolder}
          onRenameComplete={refreshFiles}
        />
      )}

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        bucket={bucket}
        prefix={prefix}
        onCreateComplete={refreshFiles}
      />
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
