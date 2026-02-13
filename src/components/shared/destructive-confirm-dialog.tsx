"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, AlertTriangle } from "lucide-react"
import {
  DESTRUCTIVE_CONFIRM_PHRASE,
  DESTRUCTIVE_CONFIRM_SCOPE,
  setDestructiveConfirmBypass,
  type DestructiveConfirmRememberOption,
} from "@/lib/destructive-confirmation"

interface DestructiveConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  actionLabel: string
  onConfirm: () => Promise<void> | void
  scope?: string
}

export function DestructiveConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  onConfirm,
  scope = DESTRUCTIVE_CONFIRM_SCOPE,
}: DestructiveConfirmDialogProps) {
  const [confirmValue, setConfirmValue] = useState("")
  const [rememberOption, setRememberOption] =
    useState<DestructiveConfirmRememberOption>("ask")
  const [isConfirming, setIsConfirming] = useState(false)

  useEffect(() => {
    if (!open) {
      setConfirmValue("")
      setRememberOption("ask")
      setIsConfirming(false)
    }
  }, [open])

  async function handleConfirm() {
    if (confirmValue.trim() !== DESTRUCTIVE_CONFIRM_PHRASE) {
      return
    }

    setIsConfirming(true)
    try {
      await onConfirm()
      setDestructiveConfirmBypass(scope, rememberOption)
      onOpenChange(false)
    } catch {
      // Caller shows the error toast.
    } finally {
      setIsConfirming(false)
    }
  }

  const requiresPhrase = confirmValue.trim() !== DESTRUCTIVE_CONFIRM_PHRASE

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="space-y-1">
            <Label htmlFor="destructive-confirm-input">Confirmation</Label>
            <p className="text-xs text-muted-foreground">
              Type <span className="font-mono">{DESTRUCTIVE_CONFIRM_PHRASE}</span> to continue.
            </p>
            <Input
              id="destructive-confirm-input"
              value={confirmValue}
              onChange={(event) => setConfirmValue(event.target.value)}
              placeholder={DESTRUCTIVE_CONFIRM_PHRASE}
              autoComplete="off"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="destructive-confirm-remember">Prompt behavior</Label>
            <Select
              value={rememberOption}
              onValueChange={(value) =>
                setRememberOption(value as DestructiveConfirmRememberOption)
              }
            >
              <SelectTrigger id="destructive-confirm-remember" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">Ask every time</SelectItem>
                <SelectItem value="one_hour">Don&apos;t ask again for 1 hour</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isConfirming}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isConfirming || requiresPhrase}
          >
            {isConfirming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
