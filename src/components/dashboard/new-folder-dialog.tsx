"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

interface NewFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bucket: string
  credentialId?: string
  prefix: string
  onCreateComplete: (createdKey: string) => void | Promise<void>
}

export function NewFolderDialog({
  open,
  onOpenChange,
  bucket,
  credentialId,
  prefix,
  onCreateComplete,
}: NewFolderDialogProps) {
  const [name, setName] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name) return

    setIsCreating(true)
    try {
      const key = prefix + name + "/"
      const res = await fetch("/api/s3/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket, credentialId, key }),
      })

      if (!res.ok) throw new Error("Failed to create folder")

      toast.success(`Folder "${name}" created`)
      setName("")
      await onCreateComplete(key)
      onOpenChange(false)
    } catch {
      toast.error("Failed to create folder")
    }
    setIsCreating(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Folder</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="folderName">Folder name</Label>
            <Input
              id="folderName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-folder"
              autoFocus
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isCreating || !name}>
              {isCreating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
