"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useTheme } from "next-themes"
import { getPreviewType, normalizeExtension, type PreviewType } from "@/lib/media"
import { highlightCode } from "@/lib/code-highlight"
import { formatSize } from "@/lib/format"

const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_CSV_ROWS = 1000

interface FilePreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileKey: string
  fileName: string
  fileSize?: number
  bucket: string
  credentialId?: string
  onDownload: () => void
  apiPrefix?: string
}

function extractExtension(key: string): string {
  const lastDot = key.lastIndexOf(".")
  if (lastDot === -1) return ""
  return key.slice(lastDot + 1)
}

function parseCSV(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  return lines.map((line) => {
    const row: string[] = []
    let current = ""
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === "," && !inQuotes) {
        row.push(current.trim())
        current = ""
      } else {
        current += char
      }
    }
    row.push(current.trim())
    return row
  })
}

export function FilePreviewDialog({
  open,
  onOpenChange,
  fileKey,
  fileName,
  fileSize,
  bucket,
  credentialId,
  onDownload,
  apiPrefix = "/api/s3",
}: FilePreviewDialogProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [codeHtml, setCodeHtml] = useState<string | null>(null)
  const [csvData, setCsvData] = useState<string[][] | null>(null)
  const [csvTruncated, setCsvTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { resolvedTheme } = useTheme()

  const previewType = useMemo<PreviewType | null>(() => {
    const ext = extractExtension(fileKey)
    return getPreviewType(ext)
  }, [fileKey])

  const fetchPreview = useCallback(async () => {
    if (!open || !fileKey) return
    if (!previewType || previewType === "image" || previewType === "video" || previewType === "odf") return

    // Guard: large files for text/CSV/code
    if (
      (previewType === "text" || previewType === "csv" || previewType === "code") &&
      fileSize &&
      fileSize > MAX_TEXT_PREVIEW_BYTES
    ) {
      setError(
        `File is too large for preview (${formatSize(fileSize)}). Maximum is 5 MB.`
      )
      return
    }

    setLoading(true)
    setError(null)
    setPreviewUrl(null)
    setTextContent(null)
    setCodeHtml(null)
    setCsvData(null)
    setCsvTruncated(false)

    try {
      const res = await fetch(`${apiPrefix}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket, credentialId, key: fileKey }),
      })
      if (!res.ok) throw new Error("Failed to load preview")
      const data = await res.json()
      if (typeof data?.url !== "string" || !data.url) {
        throw new Error("Preview URL is missing")
      }

      const url: string = data.url

      if (previewType === "office") {
        // Proxy URLs are not publicly accessible — Office viewer can't reach them
        if (url.startsWith("/api/")) {
          setError(
            "Office document preview is not available for this storage provider. Please download the file to view it."
          )
          return
        }
        setPreviewUrl(url)
      } else if (previewType === "audio") {
        setPreviewUrl(url)
      } else if (previewType === "pdf") {
        setPreviewUrl(url)
      } else if (previewType === "code") {
        const contentRes = await fetch(url)
        if (!contentRes.ok) throw new Error("Failed to fetch file content")
        const text = await contentRes.text()
        const ext = extractExtension(fileKey)
        const theme = resolvedTheme === "dark" ? "dark" : "light"
        const html = await highlightCode(text, ext, theme)
        setCodeHtml(html)
      } else if (previewType === "text" || previewType === "csv") {
        const contentRes = await fetch(url)
        if (!contentRes.ok) throw new Error("Failed to fetch file content")
        const text = await contentRes.text()

        if (previewType === "csv") {
          const allRows = parseCSV(text)
          if (allRows.length > MAX_CSV_ROWS + 1) {
            setCsvData(allRows.slice(0, MAX_CSV_ROWS + 1))
            setCsvTruncated(true)
          } else {
            setCsvData(allRows)
          }
        } else {
          setTextContent(text)
        }
      }
    } catch (previewError) {
      const message =
        previewError instanceof Error
          ? previewError.message
          : "Failed to load preview"
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [open, fileKey, fileSize, bucket, credentialId, previewType, apiPrefix, resolvedTheme])

  useEffect(() => {
    void fetchPreview()
  }, [fetchPreview])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setPreviewUrl(null)
      setTextContent(null)
      setCodeHtml(null)
      setCsvData(null)
      setCsvTruncated(false)
      setError(null)
      setLoading(false)
    }
  }, [open])

  const typeLabel = useMemo(() => {
    const ext = normalizeExtension(extractExtension(fileKey))
    return ext ? ext.toUpperCase() : previewType?.toUpperCase() ?? ""
  }, [fileKey, previewType])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col p-0 sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <div className="flex items-center justify-between gap-2 pr-8">
            <div className="flex min-w-0 items-center gap-2">
              <DialogTitle className="truncate text-sm font-medium">
                {fileName}
              </DialogTitle>
              {typeLabel && (
                <Badge variant="secondary" className="shrink-0 text-xs">
                  {typeLabel}
                </Badge>
              )}
            </div>
            <Button variant="outline" size="sm" className="shrink-0" onClick={onDownload}>
              <Download className="mr-2 h-4 w-4" />
              Download
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading preview...</span>
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
              <p className="text-center text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" onClick={onDownload}>
                <Download className="mr-2 h-4 w-4" />
                Download Instead
              </Button>
            </div>
          ) : previewType === "audio" && previewUrl ? (
            <div className="flex h-full items-center justify-center p-6">
              <audio
                src={previewUrl}
                controls
                autoPlay
                preload="metadata"
                className="w-full max-w-3xl"
              />
            </div>
          ) : previewType === "pdf" && previewUrl ? (
            <iframe
              src={previewUrl}
              className="h-full w-full border-0"
              title={`Preview: ${fileName}`}
            />
          ) : previewType === "office" && previewUrl ? (
            <iframe
              src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(previewUrl)}`}
              className="h-full w-full border-0"
              title={`Preview: ${fileName}`}
            />
          ) : previewType === "code" && codeHtml !== null ? (
            <ScrollArea className="h-full">
              <div
                className="overflow-x-auto p-4 text-sm [&_pre]:!m-0 [&_pre]:!bg-transparent"
                dangerouslySetInnerHTML={{ __html: codeHtml }}
              />
            </ScrollArea>
          ) : previewType === "text" && textContent !== null ? (
            <ScrollArea className="h-full">
              <pre className="whitespace-pre-wrap break-words p-4 font-mono text-sm">
                {textContent}
              </pre>
            </ScrollArea>
          ) : previewType === "csv" && csvData !== null ? (
            <div className="flex h-full flex-col">
              {csvTruncated && (
                <div className="shrink-0 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
                  Showing first {MAX_CSV_ROWS} rows. Download the file to see
                  all data.
                </div>
              )}
              <ScrollArea className="min-h-0 flex-1">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {csvData[0]?.map((header, i) => (
                        <TableHead key={i} className="whitespace-nowrap">
                          {header}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {csvData.slice(1).map((row, rowIdx) => (
                      <TableRow key={rowIdx}>
                        {row.map((cell, cellIdx) => (
                          <TableCell
                            key={cellIdx}
                            className="whitespace-nowrap"
                          >
                            {cell}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No preview available
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
