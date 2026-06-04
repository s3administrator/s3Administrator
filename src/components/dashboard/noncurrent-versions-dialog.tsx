"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import { DestructiveConfirmDialog } from "@/components/shared/destructive-confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { formatDate, formatSize } from "@/lib/format"

const SCAN_REQUEST_TIMEOUT_MS = 60_000
const CLEANUP_REQUEST_TIMEOUT_MS = 120_000
const DETAILS_PAGE_LIMIT = 50

const ZERO_SUMMARY = {
  noncurrentVersions: 0,
  deleteMarkers: 0,
  noncurrentSize: 0,
}

export interface NoncurrentVersionsSummary {
  noncurrentVersions: number
  deleteMarkers: number
  noncurrentSize: number
}

interface ObjectVersionItem {
  key: string
  versionId: string
  size: number
  lastModifiedUtc: string
  isLatest: boolean
  isDeleteMarker: boolean
}

interface VersionScanPagination {
  hasMore: boolean
  limit: number
  nextKeyMarker: string | null
  nextVersionIdMarker: string | null
}

interface VersionScanResponse {
  bucket: string
  credentialId: string
  summary: NoncurrentVersionsSummary | null
  versions: ObjectVersionItem[]
  pagination?: VersionScanPagination
}

interface VersionCleanupResponse {
  bucket: string
  credentialId: string
  attemptedVersions: number
  cleanedVersions: number
  failedVersions: { key: string; versionId: string; error: string }[]
  remaining: {
    summary: NoncurrentVersionsSummary
    versions: ObjectVersionItem[]
  }
}

interface NoncurrentVersionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bucket: { name: string; credentialId: string } | null
  initialSummary?: NoncurrentVersionsSummary | null
  onSummaryUpdated?: (summary: NoncurrentVersionsSummary) => void
}

function getErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Request timed out"
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "Request timed out"
  }
  return error instanceof Error ? error.message : "Request failed"
}

function mergeVersions(
  existing: ObjectVersionItem[],
  incoming: ObjectVersionItem[]
): ObjectVersionItem[] {
  const map = new Map<string, ObjectVersionItem>()
  for (const v of existing) {
    map.set(`${v.key}:${v.versionId}`, v)
  }
  for (const v of incoming) {
    map.set(`${v.key}:${v.versionId}`, v)
  }
  return Array.from(map.values())
}

export function NoncurrentVersionsDialog({
  open,
  onOpenChange,
  bucket,
  initialSummary,
  onSummaryUpdated,
}: NoncurrentVersionsDialogProps) {
  const [versions, setVersions] = useState<ObjectVersionItem[]>([])
  const [summary, setSummary] = useState<NoncurrentVersionsSummary>(
    initialSummary ?? ZERO_SUMMARY
  )
  const [pagination, setPagination] = useState<VersionScanPagination | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false)
  const [cleanupRunning, setCleanupRunning] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const initialSummaryRef = useRef<NoncurrentVersionsSummary>(
    initialSummary ?? ZERO_SUMMARY
  )

  useEffect(() => {
    initialSummaryRef.current = initialSummary ?? ZERO_SUMMARY
  }, [initialSummary])

  const fetchScan = useCallback(
    async (
      mode: "initial" | "refresh" | "load_more",
      cursor?: { keyMarker?: string; versionIdMarker?: string }
    ) => {
      if (!bucket) return

      if (mode === "initial") setLoading(true)
      else if (mode === "refresh") setRefreshing(true)
      else setLoadingMore(true)

      try {
        const abortController = new AbortController()
        const timeoutId = setTimeout(() => abortController.abort(), SCAN_REQUEST_TIMEOUT_MS)
        let res: Response
        let payload: VersionScanResponse | null
        try {
          const params = new URLSearchParams({
            bucket: bucket.name,
            credentialId: bucket.credentialId,
            details: "true",
            limit: String(DETAILS_PAGE_LIMIT),
          })

          if (mode === "initial" || mode === "refresh") {
            params.set("includeSummary", "true")
          }

          if (cursor?.keyMarker) params.set("keyMarker", cursor.keyMarker)
          if (cursor?.versionIdMarker) params.set("versionIdMarker", cursor.versionIdMarker)

          res = await fetch(`/api/s3/versions?${params.toString()}`, {
            signal: abortController.signal,
          })
          payload = (await res.json().catch(() => null)) as VersionScanResponse | null
        } finally {
          clearTimeout(timeoutId)
        }

        if (!res.ok) {
          throw new Error(
            payload && "error" in payload
              ? String((payload as { error?: string }).error)
              : "Failed to scan versions"
          )
        }

        if (!payload) throw new Error("Invalid server response")

        if (mode === "load_more") {
          setVersions((prev) => mergeVersions(prev, payload.versions))
        } else {
          setVersions(payload.versions)
        }

        setPagination(payload.pagination ?? null)

        if (payload.summary) {
          setSummary(payload.summary)
          onSummaryUpdated?.(payload.summary)
        } else if (mode !== "load_more") {
          setSummary(initialSummaryRef.current)
        }

        setErrorMessage(null)
      } catch (error) {
        setErrorMessage(getErrorMessage(error))
      } finally {
        if (mode === "initial") setLoading(false)
        else if (mode === "refresh") setRefreshing(false)
        else setLoadingMore(false)
      }
    },
    [bucket, initialSummary, onSummaryUpdated]
  )

  useEffect(() => {
    if (!open || !bucket) return
    setVersions([])
    setPagination(null)
    setErrorMessage(null)
    setSummary(initialSummaryRef.current)
    void fetchScan("initial")
  }, [open, bucket, fetchScan])

  async function handleCleanupConfirm() {
    if (!bucket) throw new Error("Bucket context missing")

    setCleanupRunning(true)
    try {
      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), CLEANUP_REQUEST_TIMEOUT_MS)
      let res: Response
      let payload: VersionCleanupResponse | null
      try {
        res = await fetch("/api/s3/versions/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify({
            bucket: bucket.name,
            credentialId: bucket.credentialId,
          }),
        })
        payload = (await res.json().catch(() => null)) as VersionCleanupResponse | null
      } finally {
        clearTimeout(timeoutId)
      }

      if (!res.ok) {
        throw new Error(
          payload && "error" in payload
            ? String((payload as { error?: string }).error)
            : "Failed to cleanup versions"
        )
      }

      if (!payload) throw new Error("Invalid server response")

      setSummary(payload.remaining.summary)
      onSummaryUpdated?.(payload.remaining.summary)
      setVersions(payload.remaining.versions)
      setPagination({
        hasMore: false,
        limit: DETAILS_PAGE_LIMIT,
        nextKeyMarker: null,
        nextVersionIdMarker: null,
      })
      setErrorMessage(null)

      if (payload.failedVersions.length === 0) {
        toast.success(
          payload.attemptedVersions === 0
            ? "No non-current versions to cleanup"
            : `Cleaned ${payload.cleanedVersions} version${payload.cleanedVersions === 1 ? "" : "s"}`
        )
      } else {
        toast.error(
          `Cleanup finished with ${payload.failedVersions.length} failure${payload.failedVersions.length === 1 ? "" : "s"}`
        )
      }
      setCleanupDialogOpen(false)
    } catch (error) {
      const message = getErrorMessage(error)
      setErrorMessage(message)
      toast.error(message)
      throw error
    } finally {
      setCleanupRunning(false)
    }
  }

  const hasMore = Boolean(
    pagination?.hasMore &&
      (pagination.nextKeyMarker || pagination.nextVersionIdMarker)
  )

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Non-Current Object Versions</DialogTitle>
            <DialogDescription>
              {bucket
                ? `Bucket: ${bucket.name}`
                : "Select a bucket to inspect object versions."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void fetchScan("refresh")}
              disabled={!bucket || loading || refreshing || loadingMore || cleanupRunning}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setCleanupDialogOpen(true)}
              disabled={!bucket || loading || cleanupRunning}
            >
              {cleanupRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Cleanup All
            </Button>
          </div>

          {errorMessage ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{errorMessage}</p>
            </div>
          ) : null}

          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Scanning non-current versions...
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="gap-1 py-4">
                  <CardHeader className="px-4 pb-0">
                    <CardTitle className="text-sm font-medium">Non-Current Versions</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 text-2xl font-semibold">
                    {summary.noncurrentVersions.toLocaleString("en-US")}
                  </CardContent>
                </Card>
                <Card className="gap-1 py-4">
                  <CardHeader className="px-4 pb-0">
                    <CardTitle className="text-sm font-medium">Delete Markers</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 text-2xl font-semibold">
                    {summary.deleteMarkers.toLocaleString("en-US")}
                  </CardContent>
                </Card>
                <Card className="gap-1 py-4">
                  <CardHeader className="px-4 pb-0">
                    <CardTitle className="text-sm font-medium">Non-Current Size</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 text-2xl font-semibold">
                    {formatSize(summary.noncurrentSize)}
                  </CardContent>
                </Card>
              </div>

              <div className="max-h-[48vh] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Object Key</TableHead>
                      <TableHead>Version ID</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Last Modified (UTC)</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {versions.length ? (
                      versions.map((item) => (
                        <TableRow key={`${item.key}:${item.versionId}`}>
                          <TableCell className="max-w-[240px] truncate">{item.key}</TableCell>
                          <TableCell className="max-w-[220px] truncate font-mono text-xs">
                            {item.versionId}
                          </TableCell>
                          <TableCell>
                            {item.isDeleteMarker ? (
                              <Badge variant="destructive" className="text-xs">
                                Delete Marker
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-xs">
                                Old Version
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDate(item.lastModifiedUtc, "—")}
                          </TableCell>
                          <TableCell className="text-right">
                            {item.isDeleteMarker ? "—" : formatSize(item.size)}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                          No non-current versions found.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void fetchScan("load_more", {
                      keyMarker: pagination?.nextKeyMarker ?? undefined,
                      versionIdMarker: pagination?.nextVersionIdMarker ?? undefined,
                    })
                  }
                  disabled={!hasMore || loadingMore || refreshing || cleanupRunning}
                >
                  {loadingMore ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Load More
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog
        open={cleanupDialogOpen}
        onOpenChange={setCleanupDialogOpen}
        title="Confirm version cleanup"
        description={
          bucket
            ? `Permanently delete all non-current versions and delete markers in "${bucket.name}"? This action cannot be undone.`
            : "Permanently delete all non-current versions and delete markers?"
        }
        actionLabel="Cleanup All"
        onConfirm={handleCleanupConfirm}
      />
    </>
  )
}
