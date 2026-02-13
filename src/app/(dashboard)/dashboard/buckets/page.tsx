"use client"

import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { BucketSettingsSheet } from "@/components/dashboard/bucket-settings-sheet"
import { DestructiveConfirmDialog } from "@/components/shared/destructive-confirm-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DESTRUCTIVE_CONFIRM_SCOPE,
  hasDestructiveConfirmBypass,
} from "@/lib/destructive-confirmation"
import { PROVIDERS, type Provider } from "@/lib/providers"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Trash2,
} from "lucide-react"

interface BucketRow {
  name: string
  creationDate: string | null
  credentialId: string
  credentialLabel?: string
  provider?: string
}

interface Credential {
  id: string
  label: string
  provider: string
}

interface BucketStatsItem {
  name: string
  totalSize: number
  fileCount: number
  credentialId: string
}

type SortField = "name" | "provider" | "credential" | "fileCount" | "indexedSize" | "createdAt"
type SortDirection = "asc" | "desc"

const PAGE_SIZE = 50

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function providerLabel(provider: string): string {
  const key = provider as Provider
  return PROVIDERS[key]?.name ?? provider
}

export default function BucketsPage() {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState("")
  const [bucketNameFilter, setBucketNameFilter] = useState("")
  const [providerFilter, setProviderFilter] = useState("all")
  const [credentialFilter, setCredentialFilter] = useState("all")
  const [sortBy, setSortBy] = useState<SortField>("name")
  const [sortDir, setSortDir] = useState<SortDirection>("asc")
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [createBucketName, setCreateBucketName] = useState("")
  const [createCredentialId, setCreateCredentialId] = useState("")
  const [creating, setCreating] = useState(false)
  const [syncingStats, setSyncingStats] = useState(false)
  const [pendingDeleteBucket, setPendingDeleteBucket] = useState<BucketRow | null>(null)
  const [settingsBucket, setSettingsBucket] = useState<BucketRow | null>(null)

  const { data: buckets = [], isLoading: bucketsLoading } = useQuery<BucketRow[]>({
    queryKey: ["buckets"],
    queryFn: async () => {
      const res = await fetch("/api/s3/buckets?all=true")
      if (!res.ok) return []
      const payload = await res.json()
      return (payload?.buckets ?? []) as BucketRow[]
    },
  })

  const { data: credentials = [] } = useQuery<Credential[]>({
    queryKey: ["credentials"],
    queryFn: async () => {
      const res = await fetch("/api/s3/credentials")
      if (!res.ok) return []
      return (await res.json()) as Credential[]
    },
  })

  const { data: bucketStats = [] } = useQuery<BucketStatsItem[]>({
    queryKey: ["bucket-stats"],
    queryFn: async () => {
      const res = await fetch("/api/s3/bucket-stats?all=true")
      if (!res.ok) return []
      const payload = await res.json()
      return (payload?.buckets ?? []) as BucketStatsItem[]
    },
  })

  useEffect(() => {
    if (!createCredentialId && credentials.length > 0) {
      setCreateCredentialId(credentials[0].id)
    }
  }, [createCredentialId, credentials])

  const setFilter = (key: "providerFilter" | "credentialFilter", value: string) => {
    setPage(1)
    if (key === "providerFilter") {
      setProviderFilter(value)
      return
    }
    setCredentialFilter(value)
  }

  const onSort = (field: SortField) => {
    setPage(1)
    if (sortBy === field) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"))
      return
    }
    setSortBy(field)
    setSortDir(field === "createdAt" ? "desc" : "asc")
  }

  const resetFilters = () => {
    setPage(1)
    setQuery("")
    setBucketNameFilter("")
    setProviderFilter("all")
    setCredentialFilter("all")
    setSortBy("name")
    setSortDir("asc")
  }

  const sortIcon = (field: SortField) => {
    if (sortBy !== field) return <ArrowUpDown className="h-3.5 w-3.5" />
    return sortDir === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    )
  }

  const statsByKey = useMemo(
    () =>
      new Map(
        bucketStats.map((item) => [`${item.credentialId}:${item.name}`, item])
      ),
    [bucketStats]
  )

  const credentialLabelById = useMemo(
    () => new Map(credentials.map((credential) => [credential.id, credential.label])),
    [credentials]
  )

  const dedupedBuckets = useMemo(() => {
    const seen = new Set<string>()
    const list: BucketRow[] = []
    for (const bucket of buckets) {
      if (!bucket.name || seen.has(bucket.name)) continue
      seen.add(bucket.name)
      list.push(bucket)
    }
    return list
  }, [buckets])

  const providersInList = useMemo(
    () =>
      Array.from(
        new Set(
          dedupedBuckets
            .map((bucket) => bucket.provider)
            .filter((provider): provider is string => typeof provider === "string" && provider.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [dedupedBuckets]
  )

  const filteredAndSortedBuckets = useMemo(() => {
    const filtered = dedupedBuckets.filter((bucket) => {
      if (
        bucketNameFilter &&
        !bucket.name.toLowerCase().includes(bucketNameFilter.toLowerCase())
      ) {
        return false
      }

      if (query) {
        const normalizedQuery = query.toLowerCase()
        const providerText = providerLabel(bucket.provider ?? "GENERIC").toLowerCase()
        const credentialText = (
          bucket.credentialLabel ??
          credentialLabelById.get(bucket.credentialId) ??
          bucket.credentialId
        ).toLowerCase()
        const nameText = bucket.name.toLowerCase()

        if (
          !nameText.includes(normalizedQuery) &&
          !providerText.includes(normalizedQuery) &&
          !credentialText.includes(normalizedQuery)
        ) {
          return false
        }
      }
      if (providerFilter !== "all" && bucket.provider !== providerFilter) {
        return false
      }
      if (credentialFilter !== "all" && bucket.credentialId !== credentialFilter) {
        return false
      }
      return true
    })

    return filtered.sort((a, b) => {
      let cmp = 0
      if (sortBy === "name") {
        cmp = a.name.localeCompare(b.name)
      } else if (sortBy === "provider") {
        cmp = providerLabel(a.provider ?? "GENERIC").localeCompare(
          providerLabel(b.provider ?? "GENERIC")
        )
      } else if (sortBy === "credential") {
        const aCredential = a.credentialLabel ?? credentialLabelById.get(a.credentialId) ?? a.credentialId
        const bCredential = b.credentialLabel ?? credentialLabelById.get(b.credentialId) ?? b.credentialId
        cmp = aCredential.localeCompare(bCredential)
      } else if (sortBy === "fileCount") {
        const aCount = statsByKey.get(`${a.credentialId}:${a.name}`)?.fileCount ?? 0
        const bCount = statsByKey.get(`${b.credentialId}:${b.name}`)?.fileCount ?? 0
        cmp = aCount - bCount
      } else if (sortBy === "indexedSize") {
        const aSize = statsByKey.get(`${a.credentialId}:${a.name}`)?.totalSize ?? 0
        const bSize = statsByKey.get(`${b.credentialId}:${b.name}`)?.totalSize ?? 0
        cmp = aSize - bSize
      } else {
        const aTime = a.creationDate ? new Date(a.creationDate).getTime() : 0
        const bTime = b.creationDate ? new Date(b.creationDate).getTime() : 0
        cmp = aTime - bTime
      }

      if (cmp === 0) {
        cmp = a.name.localeCompare(b.name)
      }
      return sortDir === "asc" ? cmp : -cmp
    })
  }, [
    credentialFilter,
    credentialLabelById,
    dedupedBuckets,
    bucketNameFilter,
    providerFilter,
    query,
    sortBy,
    sortDir,
    statsByKey,
  ])

  useEffect(() => {
    setPage(1)
  }, [query, bucketNameFilter, providerFilter, credentialFilter, sortBy, sortDir])

  const totalRows = filteredAndSortedBuckets.length
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pagedBuckets = filteredAndSortedBuckets.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  )

  async function refreshBucketQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["buckets"] }),
      queryClient.invalidateQueries({ queryKey: ["bucket-stats"] }),
      queryClient.invalidateQueries({ queryKey: ["bucket-settings"] }),
      queryClient.invalidateQueries({ queryKey: ["objects"] }),
    ])
  }

  async function handleCreateBucket(event: React.FormEvent) {
    event.preventDefault()
    if (!createBucketName.trim()) {
      toast.error("Bucket name is required")
      return
    }
    if (!createCredentialId) {
      toast.error("Credential is required")
      return
    }

    setCreating(true)
    try {
      const res = await fetch("/api/s3/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket: createBucketName.trim(),
          credentialId: createCredentialId,
        }),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(payload?.error ?? "Failed to create bucket")
      }

      toast.success("Bucket created")
      setCreateOpen(false)
      setCreateBucketName("")
      await refreshBucketQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create bucket")
    } finally {
      setCreating(false)
    }
  }

  async function handleDeleteBucket(bucket: BucketRow) {
    const res = await fetch("/api/s3/buckets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket: bucket.name,
        credentialId: bucket.credentialId,
      }),
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(payload?.error ?? "Failed to delete bucket")
    }

    toast.success("Bucket deleted")
    await refreshBucketQueries()
    setPendingDeleteBucket(null)
  }

  async function handleSyncStats() {
    const rows = filteredAndSortedBuckets
    if (rows.length === 0 || syncingStats) return

    setSyncingStats(true)
    try {
      let syncedFiles = 0
      let failed = 0

      for (const bucket of rows) {
        try {
          const res = await fetch("/api/s3/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bucket: bucket.name,
              credentialId: bucket.credentialId,
            }),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok) {
            throw new Error(payload?.error ?? `Failed to sync ${bucket.name}`)
          }
          syncedFiles += Number(payload?.synced ?? 0)
        } catch {
          failed += 1
        }
      }

      await refreshBucketQueries()

      if (failed === 0) {
        toast.success(`Synced ${syncedFiles} files across ${rows.length} buckets`)
      } else {
        toast.error(
          `Synced ${syncedFiles} files across ${rows.length - failed} buckets (${failed} failed)`
        )
      }
    } finally {
      setSyncingStats(false)
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Buckets</h1>
          <p className="text-sm text-muted-foreground">
            {totalRows} bucket{totalRows === 1 ? "" : "s"} available
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Input
            value={query}
            onChange={(event) => {
              setPage(1)
              setQuery(event.target.value)
            }}
            placeholder="Global search"
            className="w-full sm:w-80"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={resetFilters}
            className="gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" />
                Create Bucket
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Bucket</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreateBucket} className="space-y-4">
                <Input
                  id="bucket-name"
                  placeholder="Bucket name (e.g. my-new-bucket)"
                  value={createBucketName}
                  onChange={(event) => setCreateBucketName(event.target.value)}
                  required
                />
                <Select value={createCredentialId} onValueChange={setCreateCredentialId}>
                  <SelectTrigger id="bucket-credential" className="w-full">
                    <SelectValue placeholder="Select credential" />
                  </SelectTrigger>
                  <SelectContent>
                    {credentials.map((credential) => (
                      <SelectItem key={credential.id} value={credential.id}>
                        {credential.label} ({providerLabel(credential.provider)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="submit" className="w-full" disabled={creating}>
                  {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Create
                </Button>
              </form>
            </DialogContent>
          </Dialog>

          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleSyncStats()}
            disabled={syncingStats}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${syncingStats ? "animate-spin" : ""}`} />
            Sync Stats
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        {bucketsLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0"
                    onClick={() => onSort("name")}
                  >
                    Bucket {sortIcon("name")}
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0"
                    onClick={() => onSort("provider")}
                  >
                    Provider {sortIcon("provider")}
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0"
                    onClick={() => onSort("credential")}
                  >
                    Credential {sortIcon("credential")}
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0"
                    onClick={() => onSort("fileCount")}
                  >
                    Files {sortIcon("fileCount")}
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0"
                    onClick={() => onSort("indexedSize")}
                  >
                    Indexed Size {sortIcon("indexedSize")}
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="px-0"
                    onClick={() => onSort("createdAt")}
                  >
                    Created (UTC) {sortIcon("createdAt")}
                  </Button>
                </TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
              <TableRow>
                <TableHead>
                  <Input
                    className="h-8 text-xs"
                    placeholder="bucket name"
                    value={bucketNameFilter}
                    onChange={(event) => {
                      setPage(1)
                      setBucketNameFilter(event.target.value)
                    }}
                  />
                </TableHead>
                <TableHead>
                  <Select
                    value={providerFilter}
                    onValueChange={(value) => setFilter("providerFilter", value)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All providers</SelectItem>
                      {providersInList.map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {providerLabel(provider)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableHead>
                <TableHead>
                  <Select
                    value={credentialFilter}
                    onValueChange={(value) => setFilter("credentialFilter", value)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All credentials</SelectItem>
                      {credentials.map((credential) => (
                        <SelectItem key={credential.id} value={credential.id}>
                          {credential.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableHead>
                <TableHead />
                <TableHead />
                <TableHead />
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedBuckets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-20 text-center text-muted-foreground">
                    No buckets found for current filters.
                  </TableCell>
                </TableRow>
              ) : (
                pagedBuckets.map((bucket) => {
                  const stats = statsByKey.get(`${bucket.credentialId}:${bucket.name}`)
                  const fileCount = stats?.fileCount ?? 0
                  const totalSize = stats?.totalSize ?? 0

                  return (
                    <TableRow key={`${bucket.credentialId}:${bucket.name}`}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{bucket.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {providerLabel(bucket.provider ?? "GENERIC")}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs">
                        {bucket.credentialLabel ??
                          credentials.find((credential) => credential.id === bucket.credentialId)?.label ??
                          bucket.credentialId}
                      </TableCell>
                      <TableCell>{fileCount.toLocaleString("en-US")}</TableCell>
                      <TableCell>{formatSize(totalSize)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {bucket.creationDate
                          ? new Date(bucket.creationDate).toLocaleDateString("en-US", {
                              timeZone: "UTC",
                            })
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setSettingsBucket(bucket)}
                          >
                            <Settings className="mr-1.5 h-3.5 w-3.5" />
                            Settings
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                              if (hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)) {
                                void handleDeleteBucket(bucket).catch((error) => {
                                  toast.error(
                                    error instanceof Error ? error.message : "Failed to delete bucket"
                                  )
                                })
                                return
                              }
                              setPendingDeleteBucket(bucket)
                            }}
                          >
                            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground">
          Showing {(currentPage - 1) * PAGE_SIZE + (pagedBuckets.length > 0 ? 1 : 0)}-
          {(currentPage - 1) * PAGE_SIZE + pagedBuckets.length} of {totalRows} bucket
          {totalRows === 1 ? "" : "s"}.
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={currentPage <= 1}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {currentPage} / {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={currentPage >= totalPages}
          >
            Next
          </Button>
        </div>
      </div>

      <BucketSettingsSheet
        open={Boolean(settingsBucket)}
        onOpenChange={(open) => {
          if (!open) {
            setSettingsBucket(null)
          }
        }}
        bucket={
          settingsBucket
            ? { name: settingsBucket.name, credentialId: settingsBucket.credentialId }
            : null
        }
        onDeleted={async () => {
          setSettingsBucket(null)
          await refreshBucketQueries()
        }}
      />

      <DestructiveConfirmDialog
        open={Boolean(pendingDeleteBucket)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteBucket(null)
          }
        }}
        title="Confirm bucket deletion"
        description={
          pendingDeleteBucket
            ? `Delete bucket "${pendingDeleteBucket.name}"? This only works when the bucket is empty.`
            : "Delete bucket?"
        }
        actionLabel="Delete Bucket"
        onConfirm={async () => {
          if (!pendingDeleteBucket) {
            throw new Error("Missing bucket context")
          }
          await handleDeleteBucket(pendingDeleteBucket)
        }}
      />
    </div>
  )
}
