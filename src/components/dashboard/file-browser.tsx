"use client"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { FileIcon } from "@/components/dashboard/file-icon"
import { EmptyState } from "@/components/dashboard/empty-state"
import { cn } from "@/lib/utils"
import { MoreHorizontal, Download, Pencil, Trash2 } from "lucide-react"
import type { S3Object } from "@/types"

type SortColumn = "name" | "size" | "lastModified"

interface FileBrowserProps {
  prefix: string
  files: S3Object[]
  isLoading: boolean
  selectedKeys: Set<string>
  onSelect: (file: S3Object) => void
  onSelectAll: () => void
  onNavigate: (file: S3Object) => void
  onRename: (file: S3Object) => void
  onDelete: (file: S3Object) => void
  onDownload: (file: S3Object) => void
  getRowId?: (file: S3Object) => string
  getNameLabel?: (file: S3Object) => string | undefined
  pathHeader?: string
  getPathLabel?: (file: S3Object) => string | undefined
  compact?: boolean
  locationHeader?: string
  getLocationLabel?: (file: S3Object) => string | undefined
  sortBy?: SortColumn
  sortDir?: "asc" | "desc"
  onSort?: (column: SortColumn) => void
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "—"
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })
}

function getDisplayName(key: string, prefix: string): string {
  const relative = key.startsWith(prefix) ? key.slice(prefix.length) : key
  return relative.replace(/\/$/, "") || key
}

export function FileBrowser({
  prefix,
  files,
  isLoading,
  selectedKeys,
  onSelect,
  onSelectAll,
  onNavigate,
  onRename,
  onDelete,
  onDownload,
  getRowId,
  getNameLabel,
  pathHeader,
  getPathLabel,
  compact = false,
  locationHeader,
  getLocationLabel,
  sortBy,
  sortDir,
  onSort,
}: FileBrowserProps) {
  const resolveRowId = (file: S3Object) => getRowId?.(file) ?? file.key

  const renderSortableHeader = (label: string, column: SortColumn) => {
    const isActive = sortBy === column
    const indicator = isActive ? (sortDir === "asc" ? "↑" : "↓") : "↕"

    if (!onSort) return label

    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 text-left hover:text-foreground"
        onClick={() => onSort(column)}
      >
        <span>{label}</span>
        <span className="text-xs text-muted-foreground">{indicator}</span>
      </button>
    )
  }

  if (isLoading) {
    return (
      <div className="flex-1 p-4">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className={compact ? "h-8 w-full" : "h-10 w-full"} />
          ))}
        </div>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState type="no-files" />
      </div>
    )
  }

  const allSelected = files.length > 0 && selectedKeys.size === files.length

  return (
    <div className="flex-1 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={compact ? "w-8" : "w-10"}>
              <Checkbox
                checked={allSelected}
                onCheckedChange={onSelectAll}
              />
            </TableHead>
            <TableHead>{renderSortableHeader("Name", "name")}</TableHead>
            {getPathLabel && (
              <TableHead className={compact ? "w-64" : "w-80"}>
                {pathHeader ?? "Path"}
              </TableHead>
            )}
            {getLocationLabel && (
              <TableHead className={compact ? "w-40" : "w-56"}>
                {locationHeader ?? "Location"}
              </TableHead>
            )}
            <TableHead className={compact ? "w-24" : "w-28"}>
              {renderSortableHeader("Size", "size")}
            </TableHead>
            <TableHead className={compact ? "w-36" : "w-44"}>
              {renderSortableHeader("Modified", "lastModified")}
            </TableHead>
            <TableHead className={compact ? "w-8" : "w-10"} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => {
            const rowId = resolveRowId(file)
            const displayName = getNameLabel?.(file) ?? getDisplayName(file.key, prefix)
            const pathLabel = getPathLabel?.(file)
            const isSelected = selectedKeys.has(rowId)
            const location = getLocationLabel?.(file)

            return (
              <TableRow
                key={rowId}
                className={isSelected ? "bg-accent/50" : ""}
                onDoubleClick={() => {
                  if (file.isFolder) {
                    onNavigate(file)
                  } else {
                    onDownload(file)
                  }
                }}
              >
                <TableCell>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => onSelect(file)}
                  />
                </TableCell>
                <TableCell className={compact ? "py-1.5" : undefined}>
                  <button
                    className="flex w-full min-w-0 items-center gap-2 text-left hover:underline"
                    onClick={() => {
                      if (file.isFolder) onNavigate(file)
                    }}
                  >
                    <FileIcon filename={displayName} isFolder={file.isFolder} />
                    <span className={compact ? "truncate text-sm" : "truncate"}>{displayName}</span>
                    {file.isFolder && typeof file.fileCount === "number" && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        ({file.fileCount} {file.fileCount === 1 ? "file" : "files"})
                      </span>
                    )}
                  </button>
                </TableCell>
                {getPathLabel && (
                  <TableCell
                    className={cn("max-w-0 truncate text-muted-foreground", compact && "py-1.5 text-xs")}
                  >
                    {pathLabel ?? "—"}
                  </TableCell>
                )}
                {getLocationLabel && (
                  <TableCell className={cn("max-w-0 truncate text-muted-foreground", compact && "py-1.5 text-xs")}>
                    {location ?? "—"}
                  </TableCell>
                )}
                <TableCell className={cn("text-muted-foreground", compact && "py-1.5 text-xs")}>
                  {file.isFolder
                    ? typeof file.totalSize === "number"
                      ? formatSize(file.totalSize)
                      : "—"
                    : formatSize(file.size)}
                </TableCell>
                <TableCell className={cn("text-muted-foreground", compact && "py-1.5 text-xs")}>
                  {formatDate(file.lastModified)}
                </TableCell>
                <TableCell className={compact ? "py-1.5" : undefined}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={compact ? "h-7 w-7 p-0" : "h-8 w-8 p-0"}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {!file.isFolder && (
                        <DropdownMenuItem onClick={() => onDownload(file)}>
                          <Download className="mr-2 h-4 w-4" />
                          Download
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => onRename(file)}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => onDelete(file)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
