"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  CONSENT_BY_CHOICE,
  CONSENT_STORAGE_KEY,
  type ConsentChoice,
} from "@/lib/analytics-consent"

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

function applyConsent(choice: ConsentChoice) {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice)
  } catch {
    // Ignore storage failures and still try to update gtag.
  }

  window.gtag?.("consent", "update", CONSENT_BY_CHOICE[choice])
}

function isConsentChoice(value: string | null): value is ConsentChoice {
  return value === "all" || value === "analytics" || value === "essential"
}

export function ConsentBanner({ enabled }: { enabled: boolean }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!enabled) return

    try {
      const savedChoice = window.localStorage.getItem(CONSENT_STORAGE_KEY)
      if (isConsentChoice(savedChoice)) {
        applyConsent(savedChoice)
        return
      }
    } catch {
      // Ignore storage errors and display banner as fallback.
    }

    setVisible(true)
  }, [enabled])

  if (!enabled || !visible) return null

  const saveChoice = (choice: ConsentChoice) => {
    applyConsent(choice)
    setVisible(false)
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 p-4 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          We use cookies for analytics and ads personalisation. You can update this
          anytime from your browser storage settings.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => saveChoice("essential")}>
            Essential only
          </Button>
          <Button size="sm" variant="outline" onClick={() => saveChoice("analytics")}>
            Analytics only
          </Button>
          <Button size="sm" onClick={() => saveChoice("all")}>
            Accept all
          </Button>
        </div>
      </div>
    </div>
  )
}

