"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Loader2, AlertTriangle } from "lucide-react"
import { DestructiveConfirmationSection } from "@/components/shared/destructive-confirmation-section"
import { toast } from "sonner"
import {
  DESTRUCTIVE_CONFIRM_PHRASE,
  DESTRUCTIVE_CONFIRM_SCOPE,
  hasDestructiveConfirmBypass,
  setDestructiveConfirmBypass,
  type DestructiveConfirmRememberOption,
} from "@/lib/destructive-confirmation"
import type { S3Object } from "@/types"

interface DryRunSummary {
  selectedFolders: number
  selectedFiles: number
  indexedFolders: number
  indexedFiles: number
  byType: Record<string, number>
  byFolder: Array<{
    prefix: string
    fileCount: number
    byType: Record<string, number>
  }>
}

interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: S3Object[]
  bucket: string
  credentialId?: string
  onDeleteComplete: () => void | Promise<void>
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  items,
  bucket,
  credentialId,
  onDeleteComplete,
}: DeleteConfirmDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [preview, setPreview] = useState<DryRunSummary | null>(null)
  const [confirmValue, setConfirmValue] = useState("")
  const [rememberOption, setRememberOption] =
    useState<DestructiveConfirmRememberOption>("ask")
  const [bypassActive, setBypassActive] = useState(false)

  const folders = useMemo(() => items.filter((i) => i.isFolder), [items])
  const files = useMemo(() => items.filter((i) => !i.isFolder), [items])
  const typeBreakdown = useMemo(
    () => Object.entries(preview?.byType ?? {}).sort((a, b) => b[1] - a[1]),
    [preview]
  )

  const baseDeleteBody = useMemo(() => {
    const body: {
      bucket: string
      credentialId?: string
      keys?: string[]
      prefixes?: string[]
    } = { bucket }

    if (credentialId) {
      body.credentialId = credentialId
    }
    if (files.length > 0) {
      body.keys = files.map((f) => f.key)
    }
    if (folders.length > 0) {
      body.prefixes = folders.map((f) => f.key)
    }

    return body
  }, [bucket, credentialId, files, folders])

  useEffect(() => {
    if (!open || items.length === 0) {
      setPreview(null)
      setPreviewError(null)
      setConfirmValue("")
      return
    }

    const activeBypass = hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)
    setBypassActive(activeBypass)
    setRememberOption(activeBypass ? "one_hour" : "ask")

    let cancelled = false

    async function fetchPreview() {
      setIsLoadingPreview(true)
      setPreviewError(null)
      try {
        const res = await fetch("/api/s3/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseDeleteBody,
            dryRun: true,
          }),
        })

        if (!res.ok) {
          throw new Error("Preview failed")
        }

        const data = await res.json()
        if (!cancelled) {
          setPreview((data?.summary ?? null) as DryRunSummary | null)
        }
      } catch {
        if (!cancelled) {
          setPreviewError("Failed to load delete preview")
          setPreview(null)
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPreview(false)
        }
      }
    }

    fetchPreview()

    return () => {
      cancelled = true
    }
  }, [open, items, baseDeleteBody])

  async function handleDelete() {
    const activeBypass = hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)
    if (!activeBypass && confirmValue.trim() !== DESTRUCTIVE_CONFIRM_PHRASE) {
      toast.error(`Type "${DESTRUCTIVE_CONFIRM_PHRASE}" to confirm delete`)
      return
    }

    setIsDeleting(true)
    try {
      const res = await fetch("/api/s3/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseDeleteBody),
      })

      if (!res.ok) throw new Error("Delete failed")

      const data = await res.json()
      setDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE, rememberOption)
      toast.success(`Deleted ${data.deleted} item(s)`)
      await onDeleteComplete()
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
            Are you sure?
          </DialogTitle>
          <DialogDescription>
            This action cannot be undone. Review the dry-run summary below before confirming.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          {isLoadingPreview ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Calculating delete impact...
            </div>
          ) : previewError ? (
            <p className="text-destructive">{previewError}</p>
          ) : preview ? (
            <div className="space-y-2">
              <p>
                This will delete <strong>{preview.selectedFolders}</strong> selected folder
                {preview.selectedFolders !== 1 ? "s" : ""} and{" "}
                <strong>{preview.selectedFiles}</strong> selected file
                {preview.selectedFiles !== 1 ? "s" : ""}.
              </p>
              <p>
                Indexed impact: <strong>{preview.indexedFiles}</strong> file
                {preview.indexedFiles !== 1 ? "s" : ""} and{" "}
                <strong>{preview.indexedFolders}</strong> folder marker
                {preview.indexedFolders !== 1 ? "s" : ""}.
              </p>
              {typeBreakdown.length > 0 && (
                <p className="text-muted-foreground">
                  By type:{" "}
                  {typeBreakdown
                    .map(([type, count]) => `${type} (${count})`)
                    .join(", ")}
                </p>
              )}
              {preview.byFolder.length > 0 && (
                <div className="space-y-1 pt-1 text-xs text-muted-foreground">
                  {preview.byFolder.map((folder) => (
                    <p key={folder.prefix}>
                      {folder.prefix}: {folder.fileCount} file
                      {folder.fileCount !== 1 ? "s" : ""}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground">No indexed items matched this delete selection.</p>
          )}
        </div>

        <div className="max-h-40 overflow-auto rounded-md border p-2">
          {items.map((item) => (
            <p key={item.key} className="truncate text-sm">
              {item.key}
            </p>
          ))}
        </div>

        <DestructiveConfirmationSection
          bypassActive={bypassActive}
          confirmValue={confirmValue}
          onConfirmValueChange={setConfirmValue}
          rememberOption={rememberOption}
          onRememberOptionChange={setRememberOption}
          inputId="delete-confirm-input"
          selectId="delete-confirm-remember"
        />

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
            disabled={
              isDeleting ||
              isLoadingPreview ||
              (!bypassActive && confirmValue.trim() !== DESTRUCTIVE_CONFIRM_PHRASE)
            }
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
