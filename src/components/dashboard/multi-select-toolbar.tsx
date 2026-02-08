"use client"

import { Trash2, Download, X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface MultiSelectToolbarProps {
  selectedCount: number
  onDelete: () => void
  onDownload: () => void
  onClear: () => void
}

export function MultiSelectToolbar({
  selectedCount,
  onDelete,
  onDownload,
  onClear,
}: MultiSelectToolbarProps) {
  if (selectedCount === 0) return null

  return (
    <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-muted/80 px-4 py-2 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          {selectedCount} {selectedCount === 1 ? "item" : "items"} selected
        </span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onDownload}>
            <Download className="mr-1.5 h-4 w-4" />
            Download
          </Button>
          <Button variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 className="mr-1.5 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onClear}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
