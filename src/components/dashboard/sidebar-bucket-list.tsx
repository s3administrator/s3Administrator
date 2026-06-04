"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu"
import {
  HardDrive,
  RefreshCw,
  Search,
  Filter,
  ArrowUpDown,
  Cog,
  CircleAlert,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { formatSize } from "@/lib/format"

interface Bucket {
  name: string
  credentialId: string
}

interface Credential {
  id: string
  label: string
}

interface BucketStatsItem {
  name: string
  totalSize: number
  fileCount: number
  credentialId: string
}

interface SidebarBucketListProps {
  buckets: Bucket[]
  bucketsLoading: boolean
  credentials: Credential[]
  bucketStats: BucketStatsItem[]
  isSyncingAll: boolean
  syncIssueByBucketKey: Record<string, string>
  onSyncAll: () => void
  onOpenSettings: (bucket: Bucket) => void
  basePath?: string
}

export function SidebarBucketList({
  buckets,
  bucketsLoading,
  credentials,
  bucketStats,
  isSyncingAll,
  syncIssueByBucketKey,
  onSyncAll,
  onOpenSettings,
  basePath = "/dashboard",
}: SidebarBucketListProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [bucketSearch, setBucketSearch] = useState("")
  const [bucketSortField, setBucketSortField] = useState<"name" | "size" | "fileCount">("name")
  const [bucketSortDir, setBucketSortDir] = useState<"asc" | "desc">("asc")
  const [selectedCredentials, setSelectedCredentials] = useState<string[]>([])

  const statsByBucket = useMemo(
    () =>
      new Map(
        bucketStats.map((stat) => [`${stat.credentialId}:${stat.name}`, stat])
      ),
    [bucketStats]
  )

  const filteredAndSortedBuckets = useMemo(() => {
    let filtered = buckets

    if (bucketSearch) {
      filtered = filtered.filter((b) =>
        b.name.toLowerCase().includes(bucketSearch.toLowerCase())
      )
    }

    if (selectedCredentials.length > 0) {
      filtered = filtered.filter((b) =>
        selectedCredentials.includes(b.credentialId)
      )
    }

    return [...filtered].sort((a, b) => {
      const statA = statsByBucket.get(`${a.credentialId}:${a.name}`)
      const statB = statsByBucket.get(`${b.credentialId}:${b.name}`)

      let cmp = 0
      if (bucketSortField === "name") {
        cmp = a.name.localeCompare(b.name)
      } else if (bucketSortField === "size") {
        cmp = (statA?.totalSize ?? 0) - (statB?.totalSize ?? 0)
      } else {
        cmp = (statA?.fileCount ?? 0) - (statB?.fileCount ?? 0)
      }
      return bucketSortDir === "desc" ? -cmp : cmp
    })
  }, [buckets, bucketSearch, selectedCredentials, bucketSortField, bucketSortDir, statsByBucket])

  const toggleCredential = (credId: string) => {
    setSelectedCredentials((prev) =>
      prev.includes(credId) ? prev.filter((c) => c !== credId) : [...prev, credId]
    )
  }

  return (
    <ScrollArea className="min-h-0 flex-1 px-2.5 py-2.5 sm:px-3 sm:py-3">
      <div className="mb-4 space-y-2">
        <div className="flex items-center justify-between px-2">
          <p className="text-xs font-medium text-muted-foreground">Buckets</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={onSyncAll}
            disabled={bucketsLoading || !buckets?.length || isSyncingAll}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isSyncingAll && "animate-spin")} />
            Sync all
          </Button>
        </div>

        <div className="flex items-center gap-1 px-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search buckets..."
              value={bucketSearch}
              onChange={(e) => setBucketSearch(e.target.value)}
              className="h-7 pl-9 text-xs"
            />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-36">
              <DropdownMenuLabel className="text-xs">Sort by</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { setBucketSortField("name"); setBucketSortDir("asc") }}>
                Name ↑ {bucketSortField === "name" && bucketSortDir === "asc" && "✓"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setBucketSortField("name"); setBucketSortDir("desc") }}>
                Name ↓ {bucketSortField === "name" && bucketSortDir === "desc" && "✓"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { setBucketSortField("size"); setBucketSortDir("asc") }}>
                Size ↑ {bucketSortField === "size" && bucketSortDir === "asc" && "✓"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setBucketSortField("size"); setBucketSortDir("desc") }}>
                Size ↓ {bucketSortField === "size" && bucketSortDir === "desc" && "✓"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { setBucketSortField("fileCount"); setBucketSortDir("asc") }}>
                Files ↑ {bucketSortField === "fileCount" && bucketSortDir === "asc" && "✓"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setBucketSortField("fileCount"); setBucketSortDir("desc") }}>
                Files ↓ {bucketSortField === "fileCount" && bucketSortDir === "desc" && "✓"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
              >
                <Filter className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuLabel className="text-xs">Credentials</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={selectedCredentials.length === 0}
                onCheckedChange={() => setSelectedCredentials([])}
                onSelect={(e) => e.preventDefault()}
              >
                All Credentials
              </DropdownMenuCheckboxItem>
              {credentials.length > 0 && <DropdownMenuSeparator />}
              {credentials.map((cred) => (
                <DropdownMenuCheckboxItem
                  key={cred.id}
                  checked={selectedCredentials.includes(cred.id)}
                  onCheckedChange={() => toggleCredential(cred.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {cred.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {bucketsLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : filteredAndSortedBuckets.length > 0 ? (
        <div className="space-y-1">
          {filteredAndSortedBuckets.map((bucket) => {
            const href = `${basePath}?bucket=${encodeURIComponent(bucket.name)}&credentialId=${encodeURIComponent(bucket.credentialId)}`
            const isActive =
              pathname === basePath &&
              searchParams.get("bucket") === bucket.name &&
              searchParams.get("credentialId") === bucket.credentialId
            const bucketStat = statsByBucket.get(`${bucket.credentialId}:${bucket.name}`)
            const totalSize = bucketStat?.totalSize ?? 0
            const fileCount = bucketStat?.fileCount ?? 0
            const bucketKey = `${bucket.credentialId}:${bucket.name}`
            const syncIssue = syncIssueByBucketKey[bucketKey]
            return (
              <div
                key={`${bucket.credentialId}:${bucket.name}`}
                className={cn(
                  "flex items-start gap-1 rounded-md px-1 py-1 hover:bg-accent",
                  isActive && "bg-accent"
                )}
              >
                <Link
                  href={href}
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-sm px-1 py-0.5"
                >
                  <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 text-sm leading-tight break-words">
                      <span>{bucket.name}</span>
                      {syncIssue ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
                          </TooltipTrigger>
                          <TooltipContent>{syncIssue}</TooltipContent>
                        </Tooltip>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatSize(totalSize)} · {fileCount}{" "}
                      {fileCount === 1 ? "file" : "files"}
                    </p>
                  </div>
                </Link>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      aria-label={`Open settings for ${bucket.name}`}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onOpenSettings(bucket)
                      }}
                    >
                      <Cog className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Bucket settings</TooltipContent>
                </Tooltip>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="px-2 text-sm text-muted-foreground">
          {bucketSearch || selectedCredentials.length > 0
            ? "No buckets match your filters."
            : "No buckets found. Add your S3 credentials in Settings."}
        </p>
      )}
    </ScrollArea>
  )
}
