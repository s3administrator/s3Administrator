"use client"

import { useEffect, useState } from "react"
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
import { DestructiveConfirmationSection } from "@/components/shared/destructive-confirmation-section"
import { toast } from "sonner"
import {
  DESTRUCTIVE_CONFIRM_PHRASE,
  DESTRUCTIVE_CONFIRM_SCOPE,
  hasDestructiveConfirmBypass,
  setDestructiveConfirmBypass,
  type DestructiveConfirmRememberOption,
} from "@/lib/destructive-confirmation"

interface RenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  bucket: string
  credentialId?: string
  currentKey: string
  isFolder: boolean
  onRenameComplete: () => void | Promise<void>
}

export function RenameDialog({
  open,
  onOpenChange,
  bucket,
  credentialId,
  currentKey,
  isFolder,
  onRenameComplete,
}: RenameDialogProps) {
  const parts = currentKey.replace(/\/$/, "").split("/")
  const currentName = parts[parts.length - 1]
  const parentPrefix = parts.slice(0, -1).join("/")
  const parentPath = parentPrefix ? parentPrefix + "/" : ""

  const [name, setName] = useState(currentName)
  const [isRenaming, setIsRenaming] = useState(false)
  const [confirmValue, setConfirmValue] = useState("")
  const [rememberOption, setRememberOption] =
    useState<DestructiveConfirmRememberOption>("ask")
  const [bypassActive, setBypassActive] = useState(false)

  useEffect(() => {
    if (!open) {
      setConfirmValue("")
      return
    }

    const activeBypass = hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)
    setBypassActive(activeBypass)
    setRememberOption(activeBypass ? "one_hour" : "ask")
  }, [open])

  async function handleRename(e: React.FormEvent) {
    e.preventDefault()
    if (!name || name === currentName) return

    const activeBypass = hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)
    if (!activeBypass && confirmValue.trim() !== DESTRUCTIVE_CONFIRM_PHRASE) {
      toast.error(`Type "${DESTRUCTIVE_CONFIRM_PHRASE}" to confirm rename`)
      return
    }

    setIsRenaming(true)
    try {
      const newKey = parentPath + name + (isFolder ? "/" : "")
      const res = await fetch("/api/s3/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket,
          credentialId,
          operations: [{ from: currentKey, to: newKey }],
        }),
      })

      if (!res.ok) throw new Error("Rename failed")

      setDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE, rememberOption)
      toast.success("Renamed successfully")
      await onRenameComplete()
      onOpenChange(false)
    } catch {
      toast.error("Failed to rename")
    }
    setIsRenaming(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleRename} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">New name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>
          <DestructiveConfirmationSection
            bypassActive={bypassActive}
            confirmValue={confirmValue}
            onConfirmValueChange={setConfirmValue}
            rememberOption={rememberOption}
            onRememberOptionChange={setRememberOption}
            inputId="rename-confirm-input"
            selectId="rename-confirm-remember"
            description="Renaming moves the object and deletes the original key."
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                isRenaming ||
                !name ||
                (!bypassActive && confirmValue.trim() !== DESTRUCTIVE_CONFIRM_PHRASE)
              }
            >
              {isRenaming ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
