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
import { MoreHorizontal, Download, Pencil, Trash2 } from "lucide-react"
import type { S3Object } from "@/types"

interface FileBrowserProps {
  bucket: string
  prefix: string
  files: S3Object[]
  isLoading: boolean
  selectedKeys: Set<string>
  onSelect: (key: string) => void
  onSelectAll: () => void
  onNavigate: (folderKey: string) => void
  onRename: (key: string, isFolder: boolean) => void
  onDelete: (key: string, isFolder: boolean) => void
  onDownload: (key: string) => void
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
  })
}

function getDisplayName(key: string, prefix: string): string {
  const relative = key.startsWith(prefix) ? key.slice(prefix.length) : key
  return relative.replace(/\/$/, "") || key
}

export function FileBrowser({
  bucket,
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
}: FileBrowserProps) {
  if (isLoading) {
    return (
      <div className="flex-1 p-4">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
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
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected}
                onCheckedChange={onSelectAll}
              />
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead className="w-28">Size</TableHead>
            <TableHead className="w-44">Modified</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => {
            const displayName = getDisplayName(file.key, prefix)
            const isSelected = selectedKeys.has(file.key)

            return (
              <TableRow
                key={file.key}
                className={isSelected ? "bg-accent/50" : ""}
                onDoubleClick={() => {
                  if (file.isFolder) {
                    onNavigate(file.key)
                  } else {
                    onDownload(file.key)
                  }
                }}
              >
                <TableCell>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => onSelect(file.key)}
                  />
                </TableCell>
                <TableCell>
                  <button
                    className="flex items-center gap-2 text-left hover:underline"
                    onClick={() => {
                      if (file.isFolder) onNavigate(file.key)
                    }}
                  >
                    <FileIcon filename={displayName} isFolder={file.isFolder} />
                    <span className="truncate">{displayName}</span>
                  </button>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {file.isFolder ? "—" : formatSize(file.size)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(file.lastModified)}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {!file.isFolder && (
                        <DropdownMenuItem onClick={() => onDownload(file.key)}>
                          <Download className="mr-2 h-4 w-4" />
                          Download
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => onRename(file.key, file.isFolder)}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => onDelete(file.key, file.isFolder)}
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
