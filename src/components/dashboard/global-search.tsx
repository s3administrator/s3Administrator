"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Search } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FileBrowser } from "@/components/dashboard/file-browser"
import { MultiSelectToolbar } from "@/components/dashboard/multi-select-toolbar"
import { DeleteConfirmDialog } from "@/components/dashboard/delete-confirm-dialog"
import { RenameDialog } from "@/components/dashboard/rename-dialog"
import type { S3Object } from "@/types"

interface SearchResult {
  id: string
  key: string
  bucket: string
  credentialId: string
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
}

interface Bucket {
  name: string
  credentialId: string
}

interface Credential {
  id: string
  label: string
}

const FILE_TYPES = ["all", "image", "video", "audio", "document", "archive", "code", "other"]
const PAGE_SIZE = 100
const MIN_QUERY_LENGTH = 2

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

export function GlobalSearch() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const [query, setQuery] = useState("")
  const [selectedBucketScopes, setSelectedBucketScopes] = useState<string[]>([])
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<string[]>([])
  const [selectedType, setSelectedType] = useState<string>("all")
  const [sortBy, setSortBy] = useState<"name" | "size" | "lastModified">("name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [allMatchingSelected, setAllMatchingSelected] = useState(false)
  const [isBulkRunning, setIsBulkRunning] = useState(false)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteItems, setDeleteItems] = useState<SearchItem[]>([])
  const [deleteContext, setDeleteContext] = useState<{
    bucket: string
    credentialId: string
  } | null>(null)

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<SearchItem | null>(null)

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
    setAllMatchingSelected(false)
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

  const totalResults = searchData?.total ?? 0

  const items = useMemo<SearchItem[]>(
    () => (searchData?.results ?? []).map((result) => toSearchItem(result)),
    [searchData]
  )

  const selectedItems = items.filter((item) => selectedKeys.has(rowId(item)))
  const selectedCount = allMatchingSelected ? totalResults : selectedKeys.size

  const fetchAllMatchingItems = async () => {
    const allItems: SearchItem[] = []
    let currentSkip = 0
    let total = 0

    do {
      const page = await fetchSearchPage(currentSkip, PAGE_SIZE)
      if (currentSkip === 0) {
        total = page.total
      }
      if (page.results.length === 0) {
        break
      }

      allItems.push(...page.results.map((item) => toSearchItem(item)))
      currentSkip += page.results.length
    } while (currentSkip < total)

    return allItems
  }

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
    try {
      setIsBulkRunning(true)
      const targets = allMatchingSelected
        ? await fetchAllMatchingItems()
        : selectedItems

      if (targets.length > 50) {
        toast.info(`Starting ${targets.length} downloads`)
      }

      for (const item of targets) {
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
      toast.error("Bulk delete across accounts requires 'Select all matching files' mode")
      return
    }

    setDeleteItems(itemsToDelete)
    setDeleteContext({ bucket: first.bucket, credentialId: first.credentialId })
    setDeleteOpen(true)
  }

  const handleBulkDelete = async () => {
    if (allMatchingSelected) {
      const confirmed = window.confirm(
        `Start a background task to delete all ${totalResults} matching indexed files?`
      )
      if (!confirmed) return

      try {
        const res = await fetch("/api/tasks/bulk-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: queryValue,
            selectedType,
            selectedCredentialIds,
            selectedBucketScopes,
          }),
        })

        const data = await res.json()
        if (!res.ok) {
          throw new Error(data?.error ?? "Failed to create task")
        }

        queryClient.invalidateQueries({ queryKey: ["background-tasks"] })
        toast.success("Bulk delete task started")
        resetSelection()
      } catch {
        toast.error("Failed to create bulk delete task")
      }
      return
    }

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

  const canSelectAllMatching =
    !allMatchingSelected &&
    items.length > 0 &&
    selectedKeys.size === items.length &&
    totalResults > items.length

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b px-4 py-3">
        <div>
          <h1 className="text-xl font-semibold">Global Search</h1>
          <p className="text-sm text-muted-foreground">
            Search across all credentials and buckets
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[280px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by file name..."
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                resetSelection()
              }}
              className="h-9 pl-9"
              autoFocus
            />
          </div>

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Accounts {selectedCredentialIds.length > 0 && `(${selectedCredentialIds.length})`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-56"
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <DropdownMenuLabel>Filter by account</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={selectedCredentialIds.length === 0}
                onCheckedChange={() => {
                  setSelectedCredentialIds([])
                  resetSelection()
                }}
                onSelect={(event) => event.preventDefault()}
              >
                All Accounts
              </DropdownMenuCheckboxItem>
              {credentials.length > 0 && <DropdownMenuSeparator />}
              {credentials.map((credential) => (
                <DropdownMenuCheckboxItem
                  key={credential.id}
                  checked={selectedCredentialIds.includes(credential.id)}
                  onCheckedChange={() => toggleCredential(credential.id)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {credential.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Buckets {selectedBucketScopes.length > 0 && `(${selectedBucketScopes.length})`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-72"
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <DropdownMenuLabel>Filter by bucket</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={selectedBucketScopes.length === 0}
                onCheckedChange={() => {
                  setSelectedBucketScopes([])
                  resetSelection()
                }}
                onSelect={(event) => event.preventDefault()}
              >
                All Buckets
              </DropdownMenuCheckboxItem>
              {filteredBucketScopes.length > 0 && <DropdownMenuSeparator />}
              {filteredBucketScopes.map((bucket) => {
                const scope = `${bucket.credentialId}::${bucket.name}`
                const label = credentialsById.get(bucket.credentialId) ?? "Unknown"
                return (
                  <DropdownMenuCheckboxItem
                    key={scope}
                    checked={selectedBucketScopes.includes(scope)}
                    onCheckedChange={() => toggleBucketScope(scope)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {bucket.name} · {label}
                  </DropdownMenuCheckboxItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Type: {selectedType === "all" ? "All" : selectedType}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              {FILE_TYPES.map((type) => (
                <DropdownMenuItem
                  key={type}
                  onClick={() => {
                    setSelectedType(type)
                    resetSelection()
                  }}
                >
                  {type === "all" ? "All Types" : `${type[0].toUpperCase()}${type.slice(1)}`}
                  {selectedType === type && " ✓"}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {selectedCount > 0 && (
        <MultiSelectToolbar
          selectedCount={selectedCount}
          selectionHint={allMatchingSelected ? "All matching files selected" : undefined}
          selectAllLabel={
            canSelectAllMatching
              ? `Select all ${totalResults.toLocaleString()} matching files`
              : undefined
          }
          onSelectAllAcrossResults={
            canSelectAllMatching
              ? () => {
                  setSelectedKeys(new Set(items.map((item) => rowId(item))))
                  setAllMatchingSelected(true)
                }
              : undefined
          }
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
      ) : (
        <FileBrowser
          prefix=""
          files={items}
          isLoading={false}
          selectedKeys={selectedKeys}
          onSelect={(item) => {
            const next = new Set(selectedKeys)
            const id = rowId(item as SearchItem)
            if (next.has(id)) {
              next.delete(id)
              if (allMatchingSelected) {
                setAllMatchingSelected(false)
              }
            } else {
              next.add(id)
            }
            setSelectedKeys(next)
          }}
          onSelectAll={() => {
            if (selectedKeys.size === items.length) {
              resetSelection()
            } else {
              setSelectedKeys(new Set(items.map((item) => rowId(item))))
              setAllMatchingSelected(false)
            }
          }}
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
          Processing selection...
        </div>
      )}
    </div>
  )
}
