"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Database,
  LayoutDashboard,
  Settings,
  HardDrive,
  FileSearch,
  ListTodo,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { BucketSettingsSheet } from "@/components/dashboard/bucket-settings-sheet"
import { SidebarBucketList } from "@/components/dashboard/sidebar-bucket-list"

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
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isSyncingAll, setIsSyncingAll] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsBucket, setSettingsBucket] = useState<Bucket | null>(null)
  const [syncIssueByBucketKey, setSyncIssueByBucketKey] = useState<Record<string, string>>({})
  const sidebarCollapsed = collapsible && isCollapsed
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
    retry: false,
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

  async function handleSyncAll() {
    if (!buckets || buckets.length === 0 || isSyncingAll) return

    setIsSyncingAll(true)
    try {
      let syncedTotal = 0
      let failed = 0
      const nextSyncIssues: Record<string, string> = {}

      for (const bucket of buckets) {
        const bucketKey = `${bucket.credentialId}:${bucket.name}`
        try {
          const res = await fetch("/api/s3/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bucket: bucket.name,
              credentialId: bucket.credentialId,
            }),
          })

          const data = await res.json().catch(() => null)
          if (!res.ok) {
            throw new Error(data?.error ?? `Failed to sync ${bucket.name}`)
          }

          syncedTotal += Number(data?.synced ?? 0)
        } catch (error) {
          failed++
          nextSyncIssues[bucketKey] =
            error instanceof Error ? error.message : "Failed to sync bucket"
        }
      }

      setSyncIssueByBucketKey(nextSyncIssues)

      queryClient.invalidateQueries({ queryKey: ["objects"] })
      queryClient.invalidateQueries({ queryKey: ["bucket-stats"] })

      if (failed === 0) {
        toast.success(`Synced ${syncedTotal} files across ${buckets.length} buckets`)
      } else {
        toast.error(
          `Synced ${syncedTotal} files across ${buckets.length - failed} buckets (${failed} failed)`
        )
      }
    } finally {
      setIsSyncingAll(false)
    }
  }

  function openBucketSettings(bucket: Bucket) {
    setSettingsBucket(bucket)
    setSettingsOpen(true)
  }

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
            </div>
          </div>
        ) : (
          <SidebarBucketList
            buckets={buckets}
            bucketsLoading={bucketsLoading}
            credentials={credentials}
            bucketStats={bucketStats}
            isSyncingAll={isSyncingAll}
            syncIssueByBucketKey={syncIssueByBucketKey}
            onSyncAll={handleSyncAll}
            onOpenSettings={openBucketSettings}
          />
        )}

        <Separator />
        {sidebarCollapsed ? (
          <div className="space-y-1 p-2">
            <div className="flex justify-center pb-1">
              <ThemeSwitcher />
            </div>
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
