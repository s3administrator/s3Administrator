"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Loader2, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import type { S3Object } from "@/types"

interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: S3Object[]
  bucket: string
  onDeleteComplete: () => void
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  items,
  bucket,
  onDeleteComplete,
}: DeleteConfirmDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)

  const folders = items.filter((i) => i.isFolder)
  const files = items.filter((i) => !i.isFolder)

  async function handleDelete() {
    setIsDeleting(true)
    try {
      const body: { bucket: string; keys?: string[]; prefixes?: string[] } = {
        bucket,
      }

      if (files.length > 0) {
        body.keys = files.map((f) => f.key)
      }
      if (folders.length > 0) {
        body.prefixes = folders.map((f) => f.key)
      }

      const res = await fetch("/api/s3/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) throw new Error("Delete failed")

      const data = await res.json()
      toast.success(`Deleted ${data.deleted} item(s)`)
      onDeleteComplete()
      onOpenChange(false)
    } catch {
      toast.error("Failed to delete items")
    }
    setIsDeleting(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Delete {items.length} item{items.length !== 1 ? "s" : ""}?
          </DialogTitle>
          <DialogDescription>
            This action cannot be undone.
            {folders.length > 0 && (
              <>
                {" "}
                {folders.length} folder{folders.length !== 1 ? "s" : ""} will be
                deleted recursively, including all contents.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-40 overflow-auto rounded-md border p-2">
          {items.map((item) => (
            <p key={item.key} className="truncate text-sm">
              {item.key}
            </p>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
