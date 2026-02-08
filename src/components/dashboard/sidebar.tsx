"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { signOut, useSession } from "next-auth/react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Database,
  Settings,
  CreditCard,
  LogOut,
  HardDrive,
  RefreshCw,
  Shield,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface BucketStatsItem {
  name: string
  totalSize: number
  fileCount: number
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

export function Sidebar() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const { data: session } = useSession()
  const [isSyncingAll, setIsSyncingAll] = useState(false)
  const isAdmin = session?.user?.role === "admin"

  const { data: buckets, isLoading } = useQuery<{ name: string }[]>({
    queryKey: ["buckets"],
    queryFn: async () => {
      const res = await fetch("/api/s3/buckets")
      if (!res.ok) return []
      const data = await res.json()
      return data.buckets ?? []
    },
  })

  const { data: bucketStats } = useQuery<BucketStatsItem[]>({
    queryKey: ["bucket-stats"],
    queryFn: async () => {
      const res = await fetch("/api/s3/bucket-stats")
      if (!res.ok) return []
      const data = await res.json()
      return data.buckets ?? []
    },
  })

  const statsByBucketName = new Map(
    (bucketStats ?? []).map((bucketStat) => [bucketStat.name, bucketStat])
  )

  async function handleSyncAll() {
    if (!buckets || buckets.length === 0 || isSyncingAll) return

    setIsSyncingAll(true)
    try {
      let syncedTotal = 0
      for (const bucket of buckets) {
        const res = await fetch("/api/s3/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket: bucket.name }),
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

  return (
    <TooltipProvider>
      <div className="flex h-full w-56 flex-col border-r bg-muted/30">
        <div className="flex h-14 items-center border-b px-4">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <Database className="h-5 w-5" />
            <span>S3 Admin</span>
          </Link>
        </div>

        <ScrollArea className="flex-1 px-3 py-3">
          <div className="mb-2 flex items-center justify-between px-2">
            <p className="text-xs font-medium text-muted-foreground">Buckets</p>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={handleSyncAll}
              disabled={isLoading || !buckets?.length || isSyncingAll}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isSyncingAll && "animate-spin")} />
              Sync all
            </Button>
          </div>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : buckets && buckets.length > 0 ? (
            <div className="space-y-1">
              {buckets.map((bucket) => {
                const href = `/dashboard?bucket=${encodeURIComponent(bucket.name)}`
                const isActive =
                  pathname === "/dashboard" &&
                  searchParams.get("bucket") === bucket.name
                const bucketStat = statsByBucketName.get(bucket.name)
                const totalSize = bucketStat?.totalSize ?? 0
                const fileCount = bucketStat?.fileCount ?? 0
                return (
                  <Tooltip key={bucket.name}>
                    <TooltipTrigger asChild>
                      <Link
                        href={href}
                        className={cn(
                          "flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent",
                          isActive && "bg-accent"
                        )}
                      >
                        <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="truncate text-sm">{bucket.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {formatSize(totalSize)} · {fileCount}{" "}
                            {fileCount === 1 ? "file" : "files"}
                          </p>
                        </div>
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent>{bucket.name}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          ) : (
            <p className="px-2 text-sm text-muted-foreground">
              No buckets found. Add your S3 credentials in Settings.
            </p>
          )}
        </ScrollArea>

        <Separator />
        <div className="space-y-1 p-3">
          {isAdmin && (
            <Link
              href="/admin"
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                pathname === "/admin" && "bg-accent"
              )}
            >
              <Shield className="h-4 w-4" />
              Admin
            </Link>
          )}
          <Link
            href="/settings"
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
              pathname === "/settings" && "bg-accent"
            )}
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
          <Link
            href="/billing"
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
              pathname === "/billing" && "bg-accent"
            )}
          >
            <CreditCard className="h-4 w-4" />
            Billing
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 px-2"
            onClick={() => signOut({ callbackUrl: "/" })}
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </div>
    </TooltipProvider>
  )
}
