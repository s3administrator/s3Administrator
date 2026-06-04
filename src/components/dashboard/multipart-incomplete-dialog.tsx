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
import { formatDate, formatSize } from "@/lib/format"

const SCAN_REQUEST_TIMEOUT_MS = 60_000
const CLEANUP_REQUEST_TIMEOUT_MS = 60_000
const DETAILS_PAGE_LIMIT = 50

const ZERO_SUMMARY = {
  uploads: 0,
  parts: 0,
  incompleteSize: 0,
}

export interface MultipartIncompleteSummary {
  uploads: number
  parts: number
  incompleteSize: number
}

interface MultipartIncompleteUpload {
  key: string
  uploadId: string
  initiatedUtc: string | null
  partCount: number
  size: number
}

interface MultipartScanPagination {
  hasMore: boolean
  limit: number
  nextKeyMarker: string | null
  nextUploadIdMarker: string | null
}

interface MultipartIncompleteScanResponse {
  bucket: string
  credentialId: string
  summary: MultipartIncompleteSummary | null
  uploads: MultipartIncompleteUpload[]
  pagination?: MultipartScanPagination
}

interface MultipartCleanupFailedUpload {
  key: string
  uploadId: string
  error: string
}

interface MultipartCleanupResponse {
  bucket: string
  credentialId: string
  attemptedUploads: number
  cleanedUploads: number
  failedUploads: MultipartCleanupFailedUpload[]
  remaining: {
    summary: MultipartIncompleteSummary
    uploads: MultipartIncompleteUpload[]
  }
}

interface MultipartIncompleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bucket: { name: string; credentialId: string } | null
  initialSummary?: MultipartIncompleteSummary | null
  onSummaryUpdated?: (bucketKey: string, summary: MultipartIncompleteSummary) => void
  onSummaryError?: (bucketKey: string, error: string) => void
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

function mergeUploads(
  existing: MultipartIncompleteUpload[],
  incoming: MultipartIncompleteUpload[]
): MultipartIncompleteUpload[] {
  const map = new Map<string, MultipartIncompleteUpload>()
  for (const upload of existing) {
    map.set(`${upload.key}:${upload.uploadId}`, upload)
  }
  for (const upload of incoming) {
    map.set(`${upload.key}:${upload.uploadId}`, upload)
  }
  return Array.from(map.values())
}

function getPageFallbackSummary(uploads: MultipartIncompleteUpload[]): MultipartIncompleteSummary {
  return {
    uploads: uploads.length,
    parts: uploads.reduce((sum, upload) => sum + upload.partCount, 0),
    incompleteSize: uploads.reduce((sum, upload) => sum + upload.size, 0),
  }
}

export function MultipartIncompleteDialog({
  open,
  onOpenChange,
  bucket,
  initialSummary,
  onSummaryUpdated,
  onSummaryError,
}: MultipartIncompleteDialogProps) {
  const [scanData, setScanData] = useState<MultipartIncompleteScanResponse | null>(null)
  const [summary, setSummary] = useState<MultipartIncompleteSummary>(
    initialSummary ?? ZERO_SUMMARY
  )
  const [pagination, setPagination] = useState<MultipartScanPagination | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false)
  const [cleanupRunning, setCleanupRunning] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const initialSummaryRef = useRef<MultipartIncompleteSummary>(
    initialSummary ?? ZERO_SUMMARY
  )

  const bucketKey = useMemo(
    () => (bucket ? `${bucket.credentialId}:${bucket.name}` : ""),
    [bucket]
  )

  useEffect(() => {
    initialSummaryRef.current = initialSummary ?? ZERO_SUMMARY
  }, [initialSummary])

  const fetchScan = useCallback(
    async (
      mode: "initial" | "refresh" | "load_more",
      cursor?: { keyMarker?: string; uploadIdMarker?: string }
    ) => {
      if (!bucket) return

      if (mode === "initial") {
        setLoading(true)
      } else if (mode === "refresh") {
        setRefreshing(true)
      } else {
        setLoadingMore(true)
      }

      try {
        const abortController = new AbortController()
        const timeoutId = setTimeout(() => abortController.abort(), SCAN_REQUEST_TIMEOUT_MS)
        let res: Response
        let payload: MultipartIncompleteScanResponse | null
        try {
          const params = new URLSearchParams({
            bucket: bucket.name,
            credentialId: bucket.credentialId,
            details: "true",
            limit: String(DETAILS_PAGE_LIMIT),
          })

          if (cursor?.keyMarker) {
            params.set("keyMarker", cursor.keyMarker)
          }
          if (cursor?.uploadIdMarker) {
            params.set("uploadIdMarker", cursor.uploadIdMarker)
          }

          res = await fetch(`/api/s3/multipart/incomplete?${params.toString()}`, {
            signal: abortController.signal,
          })
          payload = (await res.json().catch(() => null)) as MultipartIncompleteScanResponse | null
        } finally {
          clearTimeout(timeoutId)
        }

        if (!res.ok) {
          throw new Error(
            payload && "error" in payload
              ? String(payload.error)
              : "Failed to scan multipart uploads"
          )
        }

        if (!payload) {
          throw new Error("Invalid server response")
        }

        setScanData((previous) => {
          const nextUploads =
            mode === "load_more"
              ? mergeUploads(previous?.uploads ?? [], payload.uploads)
              : payload.uploads

          return {
            bucket: payload.bucket,
            credentialId: payload.credentialId,
            summary: payload.summary,
            uploads: nextUploads,
            pagination: payload.pagination,
          }
        })
        setPagination(payload.pagination ?? null)

        if (payload.summary) {
          setSummary(payload.summary)
          onSummaryUpdated?.(bucketKey, payload.summary)
        } else if (mode !== "load_more" && initialSummary) {
          setSummary(initialSummary)
        } else if (mode !== "load_more" && !initialSummary) {
          setSummary(getPageFallbackSummary(payload.uploads))
        }

        setErrorMessage(null)
      } catch (error) {
        const message = getErrorMessage(error)
        setErrorMessage(message)
        onSummaryError?.(bucketKey, message)
      } finally {
        if (mode === "initial") {
          setLoading(false)
        } else if (mode === "refresh") {
          setRefreshing(false)
        } else {
          setLoadingMore(false)
        }
      }
    },
    [bucket, bucketKey, initialSummary, onSummaryError, onSummaryUpdated]
  )

  useEffect(() => {
    if (!open || !bucket) return
    setScanData(null)
    setPagination(null)
    setErrorMessage(null)
    setSummary(initialSummaryRef.current)
    void fetchScan("initial")
  }, [open, bucket, bucketKey, fetchScan])

  async function handleCleanupConfirm() {
    if (!bucket) {
      throw new Error("Bucket context missing")
    }

    setCleanupRunning(true)
    try {
      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), CLEANUP_REQUEST_TIMEOUT_MS)
      let res: Response
      let payload: MultipartCleanupResponse | null
      try {
        res = await fetch("/api/s3/multipart/incomplete/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify({
            bucket: bucket.name,
            credentialId: bucket.credentialId,
          }),
        })
        payload = (await res.json().catch(() => null)) as MultipartCleanupResponse | null
      } finally {
        clearTimeout(timeoutId)
      }

      if (!res.ok) {
        throw new Error(
          payload && "error" in payload
            ? String(payload.error)
            : "Failed to cleanup multipart uploads"
        )
      }

      if (!payload) {
        throw new Error("Invalid server response")
      }

      setSummary(payload.remaining.summary)
      onSummaryUpdated?.(bucketKey, payload.remaining.summary)
      setScanData({
        bucket: payload.bucket,
        credentialId: payload.credentialId,
        summary: payload.remaining.summary,
        uploads: payload.remaining.uploads,
        pagination: {
          hasMore: false,
          limit: DETAILS_PAGE_LIMIT,
          nextKeyMarker: null,
          nextUploadIdMarker: null,
        },
      })
      setPagination({
        hasMore: false,
        limit: DETAILS_PAGE_LIMIT,
        nextKeyMarker: null,
        nextUploadIdMarker: null,
      })
      setErrorMessage(null)

      if (payload.failedUploads.length === 0) {
        toast.success(
          payload.attemptedUploads === 0
            ? "No incomplete multipart uploads to cleanup"
            : `Cleaned ${payload.cleanedUploads} multipart upload${
                payload.cleanedUploads === 1 ? "" : "s"
              }`
        )
      } else {
        toast.error(
          `Cleanup finished with ${payload.failedUploads.length} failure${
            payload.failedUploads.length === 1 ? "" : "s"
          }`
        )
      }
      setCleanupDialogOpen(false)
    } catch (error) {
      const message = getErrorMessage(error)
      setErrorMessage(message)
      onSummaryError?.(bucketKey, message)
      toast.error(message)
      throw error
    } finally {
      setCleanupRunning(false)
    }
  }

  const hasMore = Boolean(
    pagination?.hasMore &&
      pagination.nextKeyMarker &&
      pagination.nextUploadIdMarker
  )

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Incomplete Multipart Uploads</DialogTitle>
            <DialogDescription>
              {bucket ? `Bucket: ${bucket.name}` : "Select a bucket to inspect multipart uploads."}
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
              Scanning incomplete multipart uploads...
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="gap-1 py-4">
                  <CardHeader className="px-4 pb-0">
                    <CardTitle className="text-sm font-medium">Uploads</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 text-2xl font-semibold">
                    {summary.uploads.toLocaleString("en-US")}
                  </CardContent>
                </Card>
                <Card className="gap-1 py-4">
                  <CardHeader className="px-4 pb-0">
                    <CardTitle className="text-sm font-medium">Parts</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 text-2xl font-semibold">
                    {summary.parts.toLocaleString("en-US")}
                  </CardContent>
                </Card>
                <Card className="gap-1 py-4">
                  <CardHeader className="px-4 pb-0">
                    <CardTitle className="text-sm font-medium">Incomplete Size</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 text-2xl font-semibold">
                    {formatSize(summary.incompleteSize)}
                  </CardContent>
                </Card>
              </div>

              <div className="max-h-[48vh] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Object Key</TableHead>
                      <TableHead>Upload ID</TableHead>
                      <TableHead>Initiated (UTC)</TableHead>
                      <TableHead className="text-right">Part Count</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scanData?.uploads.length ? (
                      scanData.uploads.map((item) => (
                        <TableRow key={`${item.key}:${item.uploadId}`}>
                          <TableCell className="max-w-[240px] truncate">{item.key}</TableCell>
                          <TableCell className="max-w-[220px] truncate font-mono text-xs">
                            {item.uploadId}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDate(item.initiatedUtc, "—")}
                          </TableCell>
                          <TableCell className="text-right">
                            {item.partCount.toLocaleString("en-US")}
                          </TableCell>
                          <TableCell className="text-right">{formatSize(item.size)}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                          No incomplete multipart uploads found.
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
                      uploadIdMarker: pagination?.nextUploadIdMarker ?? undefined,
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
        title="Confirm multipart cleanup"
        description={
          bucket
            ? `Abort all incomplete multipart uploads in "${bucket.name}"?`
            : "Abort all incomplete multipart uploads?"
        }
        actionLabel="Cleanup All"
        onConfirm={handleCleanupConfirm}
      />
    </>
  )
}
