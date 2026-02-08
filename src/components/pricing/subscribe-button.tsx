"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

interface SubscribeButtonProps {
  planId: string
  label: string
  popular: boolean
}

export function SubscribeButton({ planId, label, popular }: SubscribeButtonProps) {
  const [loading, setLoading] = useState(false)

  async function handleClick() {
    setLoading(true)
    try {
      const res = await fetch("/api/stripe/checkout/guest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        toast.error(data.error || "Failed to start checkout")
        setLoading(false)
      }
    } catch {
      toast.error("Failed to start checkout")
      setLoading(false)
    }
  }

  return (
    <Button
      className="w-full"
      variant={popular ? "default" : "outline"}
      onClick={handleClick}
      disabled={loading}
    >
      {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {label}
    </Button>
  )
}
