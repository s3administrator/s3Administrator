"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DESTRUCTIVE_CONFIRM_PHRASE,
  type DestructiveConfirmRememberOption,
} from "@/lib/destructive-confirmation"

interface DestructiveConfirmationSectionProps {
  bypassActive: boolean
  confirmValue: string
  onConfirmValueChange: (value: string) => void
  rememberOption: DestructiveConfirmRememberOption
  onRememberOptionChange: (option: DestructiveConfirmRememberOption) => void
  inputId?: string
  selectId?: string
  description?: string
}

export function DestructiveConfirmationSection({
  bypassActive,
  confirmValue,
  onConfirmValueChange,
  rememberOption,
  onRememberOptionChange,
  inputId = "destructive-confirm-input",
  selectId = "destructive-confirm-remember",
  description,
}: DestructiveConfirmationSectionProps) {
  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      {!bypassActive ? (
        <div className="space-y-1">
          <Label htmlFor={inputId}>Confirmation</Label>
          <p className="text-xs text-muted-foreground">
            {description ? `${description} ` : ""}
            Type <span className="font-mono">{DESTRUCTIVE_CONFIRM_PHRASE}</span> to
            continue.
          </p>
          <Input
            id={inputId}
            value={confirmValue}
            onChange={(event) => onConfirmValueChange(event.target.value)}
            placeholder={DESTRUCTIVE_CONFIRM_PHRASE}
            autoComplete="off"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Confirmation bypass is currently active on this browser.
        </p>
      )}
      <div className="space-y-1">
        <Label htmlFor={selectId}>Prompt behavior</Label>
        <Select
          value={rememberOption}
          onValueChange={(value) =>
            onRememberOptionChange(value as DestructiveConfirmRememberOption)
          }
        >
          <SelectTrigger id={selectId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ask">Ask every time</SelectItem>
            <SelectItem value="one_hour">Don&apos;t ask again for 1 hour</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
