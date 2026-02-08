"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"

interface OverviewSummary {
  indexedBucketCount: number
  indexedFileCount: number
  indexedTotalSize: number
  distinctExtensionCount: number
  lastIndexedAt: string | null
}

interface OverviewBucket {
  bucket: string
  credentialId: string
  credentialLabel: string
  fileCount: number
  totalSize: number
}

interface OverviewExtension {
  extension: string
  fileCount: number
  totalSize: number
  type: string
}

interface OverviewType {
  type: string
  fileCount: number
  totalSize: number
}

interface OverviewResponse {
  summary: OverviewSummary
  buckets: OverviewBucket[]
  extensions: OverviewExtension[]
  types: OverviewType[]
}

interface BucketRef {
  name: string
  credentialId: string
}

interface RefreshProgress {
  current: number
  total: number
  bucketName: string
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function formatCount(value: number): string {
  return Number(value || 0).toLocaleString()
}

function formatDate(value: string | null): string {
  if (!value) return "Never"
  return new Date(value).toLocaleString()
}

function titleCase(value: string): string {
  if (!value) return value
  return `${value[0].toUpperCase()}${value.slice(1)}`
}

function extensionLabel(extension: string): string {
  return extension ? `.${extension}` : "(no extension)"
}

export function DashboardOverview() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress | null>(null)
  const isRefreshingRef = useRef(false)
  const autoRefreshStartedRef = useRef(false)

  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery<OverviewResponse>({
    queryKey: ["dashboard-overview"],
    queryFn: async () => {
      const res = await fetch("/api/s3/overview")
      if (!res.ok) {
        throw new Error("Failed to load overview")
      }
      return res.json() as Promise<OverviewResponse>
    },
  })

  const runLiveRefresh = useCallback(async (trigger: "auto" | "manual") => {
    if (isRefreshingRef.current) return
    isRefreshingRef.current = true
    setIsRefreshing(true)
    setRefreshProgress(null)

    let successCount = 0
    let failureCount = 0
    let syncedTotal = 0

    try {
      const bucketsRes = await fetch("/api/s3/buckets?all=true")
      if (!bucketsRes.ok) {
        throw new Error("Failed to load buckets")
      }

      const bucketData = (await bucketsRes.json()) as { buckets?: BucketRef[] }
      const buckets = bucketData.buckets ?? []

      if (buckets.length === 0) {
        toast.info("No buckets available for live refresh")
        return
      }

      for (let index = 0; index < buckets.length; index++) {
        const bucket = buckets[index]
        setRefreshProgress({
          current: index + 1,
          total: buckets.length,
          bucketName: bucket.name,
        })

        try {
          const syncRes = await fetch("/api/s3/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bucket: bucket.name,
              credentialId: bucket.credentialId,
            }),
          })

          const syncData = await syncRes.json().catch(() => ({}))
          if (syncRes.ok) {
            successCount++
            syncedTotal += Number(syncData?.synced ?? 0)
          } else {
            failureCount++
          }
        } catch {
          failureCount++
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh metadata"
      toast.error(message)
      return
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard-overview"] }),
        queryClient.invalidateQueries({ queryKey: ["bucket-stats"] }),
        queryClient.invalidateQueries({ queryKey: ["objects"] }),
      ])
      isRefreshingRef.current = false
      setIsRefreshing(false)
      setRefreshProgress(null)
    }

    if (failureCount === 0) {
      const prefix = trigger === "auto" ? "Auto refresh complete" : "Refresh complete"
      toast.success(`${prefix}: synced ${formatCount(syncedTotal)} file(s) across ${successCount} bucket(s)`)
      return
    }

    toast.error(
      `Refresh finished: ${successCount} bucket(s) succeeded, ${failureCount} failed, ${formatCount(syncedTotal)} file(s) synced`
    )
  }, [queryClient])

  useEffect(() => {
    if (autoRefreshStartedRef.current) return
    autoRefreshStartedRef.current = true
    void runLiveRefresh("auto")
  }, [runLiveRefresh])

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Overview unavailable</CardTitle>
            <CardDescription>
              Could not load metadata overview for your buckets.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const refreshPercent = refreshProgress && refreshProgress.total > 0
    ? Math.round((refreshProgress.current / refreshProgress.total) * 100)
    : 0

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Indexed snapshot with live refresh across all buckets
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void runLiveRefresh("manual")}
          disabled={isRefreshing}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          Refresh Live Metadata
        </Button>
      </div>

      {refreshProgress && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Live refresh in progress</CardTitle>
            <CardDescription>
              Syncing {refreshProgress.current}/{refreshProgress.total}: {refreshProgress.bucketName}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${refreshPercent}%` }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Indexed Buckets</CardDescription>
            <CardTitle>{formatCount(data.summary.indexedBucketCount)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Indexed Files</CardDescription>
            <CardTitle>{formatCount(data.summary.indexedFileCount)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Indexed Size</CardDescription>
            <CardTitle>{formatSize(data.summary.indexedTotalSize)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Distinct Extensions</CardDescription>
            <CardTitle>{formatCount(data.summary.distinctExtensionCount)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Index status</CardTitle>
          <CardDescription>
            Last indexed object timestamp: {formatDate(data.summary.lastIndexedAt)}
          </CardDescription>
        </CardHeader>
        {data.summary.indexedFileCount === 0 && (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No indexed metadata yet. Use live refresh to build this overview.
            </p>
          </CardContent>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Type</CardTitle>
            <CardDescription>Grouped using existing file type categories</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.types.map((entry) => (
                <div key={entry.type} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{titleCase(entry.type)}</p>
                    <p className="text-xs text-muted-foreground">{formatCount(entry.fileCount)} files</p>
                  </div>
                  <p className="text-sm">{formatSize(entry.totalSize)}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Extension</CardTitle>
            <CardDescription>Extension-level distribution from indexed metadata</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-[360px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Extension</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.extensions.map((entry) => (
                    <TableRow key={entry.extension || "none"}>
                      <TableCell>{extensionLabel(entry.extension)}</TableCell>
                      <TableCell>{titleCase(entry.type)}</TableCell>
                      <TableCell className="text-right">{formatCount(entry.fileCount)}</TableCell>
                      <TableCell className="text-right">{formatSize(entry.totalSize)}</TableCell>
                    </TableRow>
                  ))}
                  {data.extensions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No extension stats available yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By Bucket</CardTitle>
          <CardDescription>Click a bucket row to open explorer view</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-[420px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bucket</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Files</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.buckets.map((entry) => (
                  <TableRow
                    key={`${entry.credentialId}:${entry.bucket}`}
                    className="cursor-pointer"
                    onClick={() => {
                      const params = new URLSearchParams({
                        bucket: entry.bucket,
                        credentialId: entry.credentialId,
                      })
                      router.push(`/dashboard?${params}`)
                    }}
                  >
                    <TableCell>{entry.bucket}</TableCell>
                    <TableCell>{entry.credentialLabel}</TableCell>
                    <TableCell className="text-right">{formatCount(entry.fileCount)}</TableCell>
                    <TableCell className="text-right">{formatSize(entry.totalSize)}</TableCell>
                  </TableRow>
                ))}
                {data.buckets.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      No indexed bucket metadata available yet
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
