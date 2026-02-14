"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { signOut, useSession } from "next-auth/react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
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
  Database,
  LayoutDashboard,
  Settings,
  CreditCard,
  LogOut,
  HardDrive,
  RefreshCw,
  Shield,
  Search,
  Filter,
  ArrowUpDown,
  FileSearch,
  ListTodo,
  Activity,
  ChevronsLeft,
  ChevronsRight,
  Cog,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { BucketSettingsSheet } from "@/components/dashboard/bucket-settings-sheet"

interface BucketStatsItem {
  name: string
  totalSize: number
  fileCount: number
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

interface BackgroundTask {
  id: string
  type: string
  title: string
  status: "pending" | "in_progress" | "completed" | "failed"
  progress?: {
    total?: number
    processed?: number
    copied?: number
    moved?: number
    deleted?: number
    skipped?: number
    failed?: number
    remaining?: number
  } | null
  lastError?: string | null
  updatedAt: string
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

export function Sidebar({
  className,
  collapsible = true,
}: {
  className?: string
  collapsible?: boolean
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const { data: session } = useSession()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isSyncingAll, setIsSyncingAll] = useState(false)
  const [bucketSearch, setBucketSearch] = useState("")
  const [bucketSortField, setBucketSortField] = useState<"name" | "size" | "fileCount">("name")
  const [bucketSortDir, setBucketSortDir] = useState<"asc" | "desc">("asc")
  const [selectedCredentials, setSelectedCredentials] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsBucket, setSettingsBucket] = useState<Bucket | null>(null)
  const sidebarCollapsed = collapsible && isCollapsed
  const isAdmin = session?.user?.role === "admin"
  const isCommunity = (process.env.NEXT_PUBLIC_EDITION || "").trim().toLowerCase() !== "cloud"
  const isOverviewActive =
    pathname === "/dashboard" &&
    !searchParams.get("bucket") &&
    !searchParams.get("prefix")
  const isBucketsPageActive = pathname === "/dashboard/buckets"
  const isTasksActive = pathname === "/dashboard/tasks"

  const { data: buckets = [], isLoading: bucketsLoading } = useQuery<Bucket[]>({
    queryKey: ["buckets"],
    queryFn: async () => {
      const res = await fetch("/api/s3/buckets?all=true")
      if (!res.ok) return []
      const data = await res.json()
      return data.buckets ?? []
    },
  })

  const { data: credentials = [] } = useQuery<Credential[]>({
    queryKey: ["credentials"],
    queryFn: async () => {
      const res = await fetch("/api/s3/credentials")
      if (!res.ok) return []
      return res.json()
    },
  })

  const { data: bucketStats = [] } = useQuery<BucketStatsItem[]>({
    queryKey: ["bucket-stats"],
    queryFn: async () => {
      const res = await fetch("/api/s3/bucket-stats?all=true")
      if (!res.ok) return []
      const data = await res.json()
      return data.buckets ?? []
    },
  })

  const { data: tasksData } = useQuery<{ tasks: BackgroundTask[] }>({
    queryKey: ["background-tasks"],
    queryFn: async () => {
      const res = await fetch("/api/tasks?scope=ongoing&limit=5")
      if (!res.ok) return { tasks: [] }
      return (await res.json()) as { tasks: BackgroundTask[] }
    },
  })
  const tasks = tasksData?.tasks ?? []
  const hasRunnableTasks = tasks.some((task) => task.status === "pending" || task.status === "in_progress")

  const statsByBucket = useMemo(
    () =>
      new Map(
        bucketStats.map((stat) => [`${stat.credentialId}:${stat.name}`, stat])
      ),
    [bucketStats]
  )

  // Filter and sort buckets
  const filteredAndSortedBuckets = useMemo(() => {
    let filtered = buckets

    // Filter by search
    if (bucketSearch) {
      filtered = filtered.filter((b) =>
        b.name.toLowerCase().includes(bucketSearch.toLowerCase())
      )
    }

    // Filter by selected credentials
    if (selectedCredentials.length > 0) {
      filtered = filtered.filter((b) =>
        selectedCredentials.includes(b.credentialId)
      )
    }

    // Sort
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

  async function handleSyncAll() {
    if (!buckets || buckets.length === 0 || isSyncingAll) return

    setIsSyncingAll(true)
    try {
      let syncedTotal = 0
      for (const bucket of buckets) {
        const res = await fetch("/api/s3/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bucket: bucket.name,
            credentialId: bucket.credentialId,
          }),
        })

        const data = await res.json()
        if (!res.ok) {
          throw new Error(data?.error ?? `Failed to sync ${bucket.name}`)
        }

        syncedTotal += Number(data?.synced ?? 0)
      }

      queryClient.invalidateQueries({ queryKey: ["objects"] })
      queryClient.invalidateQueries({ queryKey: ["bucket-stats"] })
      toast.success(`Synced ${syncedTotal} files across ${buckets.length} buckets`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to sync all buckets"
      toast.error(message)
    } finally {
      setIsSyncingAll(false)
    }
  }

  const toggleCredential = (credId: string) => {
    setSelectedCredentials((prev) =>
      prev.includes(credId) ? prev.filter((c) => c !== credId) : [...prev, credId]
    )
  }

  function openBucketSettings(bucket: Bucket) {
    setSettingsBucket(bucket)
    setSettingsOpen(true)
  }

  const processTaskQueue = useCallback(async () => {
    try {
      let processedAny = false
      for (let i = 0; i < 40; i++) {
        const res = await fetch("/api/tasks/process", { method: "POST" })
        if (!res.ok) break

        const data = await res.json()
        if (!data?.processed) {
          break
        }
        processedAny = true
      }

      if (processedAny) {
        queryClient.invalidateQueries({ queryKey: ["background-tasks"] })
        queryClient.invalidateQueries({ queryKey: ["bucket-stats"] })
        queryClient.invalidateQueries({ queryKey: ["objects"] })
      }
    } catch {
      // Background processing can fail temporarily; it will retry on next poll.
    }
  }, [queryClient])

  useEffect(() => {
    if (!hasRunnableTasks) return

    const interval = window.setInterval(() => {
      void processTaskQueue()
    }, 60_000)

    return () => window.clearInterval(interval)
  }, [hasRunnableTasks, processTaskQueue])

  return (
    <TooltipProvider>
      <div
        className={cn(
          "relative z-50 flex h-full min-w-0 flex-col border-r bg-muted/30 transition-[width] duration-200",
          sidebarCollapsed ? "w-20 lg:w-20" : "w-80 lg:w-96",
          className
        )}
      >
        <div
          className={cn(
            "flex h-14 items-center border-b",
            sidebarCollapsed ? "justify-between px-2" : "justify-between px-4"
          )}
        >
          <Link
            href="/dashboard"
            className={cn(
              "flex items-center font-semibold",
              sidebarCollapsed ? "justify-center px-1" : "gap-2"
            )}
          >
            <Database className="h-5 w-5" />
            {!sidebarCollapsed && <span>S3 Administrator</span>}
          </Link>
          {sidebarCollapsed ? (
            collapsible && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setIsCollapsed(false)}
                title="Expand sidebar"
                aria-label="Expand sidebar"
              >
                <ChevronsRight className="h-4 w-4" />
              </Button>
            )
          ) : (
            <div className="flex items-center gap-1">
              <ThemeSwitcher />
              {collapsible && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setIsCollapsed(true)}
                  title="Collapse sidebar"
                  aria-label="Collapse sidebar"
                >
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </div>

        {sidebarCollapsed ? (
          <div className="flex-1 overflow-y-auto p-2">
            <div className="space-y-1">
              <Link
                href="/dashboard"
                title="Overview"
                className={cn(
                  "flex justify-center rounded-md px-2 py-2 hover:bg-accent",
                  isOverviewActive && "bg-accent"
                )}
              >
                <LayoutDashboard className="h-4 w-4" />
              </Link>
              <Link
                href="/dashboard/search"
                title="Search All Files"
                className={cn(
                  "flex justify-center rounded-md px-2 py-2 hover:bg-accent",
                  pathname === "/dashboard/search" && "bg-accent"
                )}
              >
                <FileSearch className="h-4 w-4" />
              </Link>
              <Link
                href="/dashboard/buckets"
                title="Buckets"
                className={cn(
                  "flex justify-center rounded-md px-2 py-2 hover:bg-accent",
                  isBucketsPageActive && "bg-accent"
                )}
              >
                <HardDrive className="h-4 w-4" />
              </Link>
              {!isCommunity && (
                <Link
                  href="/audit-logs"
                  title="Audit Logs"
                  className={cn(
                    "flex justify-center rounded-md px-2 py-2 hover:bg-accent",
                    pathname === "/audit-logs" && "bg-accent"
                  )}
                >
                  <Activity className="h-4 w-4" />
                </Link>
              )}
              <Link
                href="/dashboard/tasks"
                title="Tasks"
                className={cn(
                  "flex justify-center rounded-md px-2 py-2 hover:bg-accent",
                  isTasksActive && "bg-accent"
                )}
              >
                <ListTodo className="h-4 w-4" />
              </Link>
              {!isCommunity && isAdmin && (
                <Link
                  href="/admin"
                  title="Admin"
                  className={cn(
                    "flex justify-center rounded-md px-2 py-2 hover:bg-accent",
                    pathname === "/admin" && "bg-accent"
                  )}
                >
                  <Shield className="h-4 w-4" />
                </Link>
              )}
              <Link
                href="/settings"
                title="Settings"
                className={cn(
                  "flex justify-center rounded-md px-2 py-2 hover:bg-accent",
                  pathname === "/settings" && "bg-accent"
                )}
              >
                <Settings className="h-4 w-4" />
              </Link>
              {!isCommunity && (
                <Link
                  href="/billing"
                  title="Billing"
                  className={cn(
                    "flex justify-center rounded-md px-2 py-2 hover:bg-accent",
                    pathname === "/billing" && "bg-accent"
                  )}
                >
                  <CreditCard className="h-4 w-4" />
                </Link>
              )}
            </div>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1 px-2.5 py-2.5 sm:px-3 sm:py-3">
            <div className="mb-4 space-y-2">
              <div className="flex items-center justify-between px-2">
                <p className="text-xs font-medium text-muted-foreground">Buckets</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={handleSyncAll}
                  disabled={bucketsLoading || !buckets?.length || isSyncingAll}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", isSyncingAll && "animate-spin")} />
                  Sync all
                </Button>
              </div>

              {/* Search input with Sort and Filter icons */}
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

                {/* Sort icon */}
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

                {/* Filter icon */}
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

            {/* Bucket list */}
            {bucketsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : filteredAndSortedBuckets.length > 0 ? (
              <div className="space-y-1">
                {filteredAndSortedBuckets.map((bucket) => {
                  const href = `/dashboard?bucket=${encodeURIComponent(bucket.name)}&credentialId=${encodeURIComponent(bucket.credentialId)}`
                  const isActive =
                    pathname === "/dashboard" &&
                    searchParams.get("bucket") === bucket.name &&
                    searchParams.get("credentialId") === bucket.credentialId
                  const bucketStat = statsByBucket.get(`${bucket.credentialId}:${bucket.name}`)
                  const totalSize = bucketStat?.totalSize ?? 0
                  const fileCount = bucketStat?.fileCount ?? 0
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
                          <p className="text-sm leading-tight break-words">{bucket.name}</p>
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
                              openBucketSettings(bucket)
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
        )}

        <Separator />
        {sidebarCollapsed ? (
          <div className="space-y-1 p-2">
            <div className="flex justify-center pb-1">
              <ThemeSwitcher />
            </div>
            {!isCommunity && (
              <Button
                variant="ghost"
                size="sm"
                title="Sign Out"
                className="h-8 w-full justify-center px-2"
                onClick={() => signOut({ callbackUrl: "/" })}
              >
                <LogOut className="h-4 w-4" />
                <span className="sr-only">Sign Out</span>
              </Button>
            )}
          </div>
        ) : (
          <div className="shrink-0 space-y-0.5 p-2 pb-4 sm:space-y-1 sm:p-3">
            <Link
              href="/dashboard"
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent sm:py-1.5 sm:text-sm",
                isOverviewActive && "bg-accent"
              )}
            >
              <LayoutDashboard className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Overview
            </Link>

            <Link
              href="/dashboard/search"
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent sm:py-1.5 sm:text-sm",
                pathname === "/dashboard/search" && "bg-accent"
              )}
            >
              <FileSearch className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Search All Files
            </Link>

            <Link
              href="/dashboard/buckets"
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent sm:py-1.5 sm:text-sm",
                isBucketsPageActive && "bg-accent"
              )}
            >
              <HardDrive className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Buckets
            </Link>

            {!isCommunity && (
              <Link
                href="/audit-logs"
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent sm:py-1.5 sm:text-sm",
                  pathname === "/audit-logs" && "bg-accent"
                )}
              >
                <Activity className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                Audit Logs
              </Link>
            )}

            <Link
              href="/dashboard/tasks"
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent sm:py-1.5 sm:text-sm",
                isTasksActive && "bg-accent"
              )}
            >
              <ListTodo className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Tasks
            </Link>

            {!isCommunity && isAdmin && (
              <Link
                href="/admin"
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent sm:py-1.5 sm:text-sm",
                  pathname === "/admin" && "bg-accent"
                )}
              >
                <Shield className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                Admin
              </Link>
            )}
            <Link
              href="/settings"
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent sm:py-1.5 sm:text-sm",
                pathname === "/settings" && "bg-accent"
              )}
            >
              <Settings className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Settings
            </Link>
            {!isCommunity && (
              <Link
                href="/billing"
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent sm:py-1.5 sm:text-sm",
                  pathname === "/billing" && "bg-accent"
                )}
              >
                <CreditCard className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                Billing
              </Link>
            )}
            {!isCommunity && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-full justify-start gap-2 px-2 text-xs sm:h-9 sm:text-sm"
                onClick={() => signOut({ callbackUrl: "/" })}
              >
                <LogOut className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                Sign Out
              </Button>
            )}
          </div>
        )}
      </div>
      <BucketSettingsSheet
        open={settingsOpen}
        onOpenChange={(nextOpen) => {
          setSettingsOpen(nextOpen)
          if (!nextOpen) {
            setSettingsBucket(null)
          }
        }}
        bucket={settingsBucket}
        onDeleted={async () => {
          await queryClient.invalidateQueries({ queryKey: ["buckets"] })
          await queryClient.invalidateQueries({ queryKey: ["bucket-stats"] })
        }}
      />
    </TooltipProvider>
  )
}
