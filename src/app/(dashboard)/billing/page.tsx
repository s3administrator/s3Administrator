"use client"

import { useQuery } from "@tanstack/react-query"
import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Check, Loader2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

const plans = [
  {
    tier: "free",
    name: "Free",
    price: "$0",
    features: ["1 bucket", "1,000 cached files"],
  },
  {
    tier: "starter",
    name: "Starter",
    price: "$3",
    features: ["10 buckets", "10,000 cached files", "Priority support"],
  },
  {
    tier: "pro",
    name: "Pro",
    price: "$9",
    features: [
      "Unlimited buckets",
      "100,000 cached files",
      "Priority support",
    ],
  },
  {
    tier: "enterprise",
    name: "Enterprise",
    price: "Custom",
    features: [
      "Unlimited buckets",
      "Unlimited cached files",
      "Dedicated support",
    ],
  },
]

export default function BillingPage() {
  const { data: session } = useSession()
  const [upgrading, setUpgrading] = useState<string | null>(null)

  const { data: usage } = useQuery({
    queryKey: ["usage"],
    queryFn: async () => {
      const res = await fetch("/api/s3/usage")
      if (!res.ok) return { tier: "free", fileCount: 0, bucketCount: 0 }
      return res.json()
    },
  })

  const currentTier = usage?.tier || "free"

  async function handleUpgrade(tier: string) {
    if (tier === currentTier) return
    setUpgrading(tier)
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      })
      const { url } = await res.json()
      if (url) {
        window.location.href = url
      } else {
        toast.error("Failed to create checkout session")
      }
    } catch {
      toast.error("Failed to start upgrade")
    }
    setUpgrading(null)
  }

  async function handleManage() {
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" })
      const { url } = await res.json()
      if (url) window.location.href = url
    } catch {
      toast.error("Failed to open billing portal")
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Manage your subscription and usage
        </p>
      </div>

      {usage && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Current Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-8">
              <div>
                <p className="text-2xl font-bold">{usage.fileCount ?? 0}</p>
                <p className="text-sm text-muted-foreground">Cached files</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{usage.bucketCount ?? 0}</p>
                <p className="text-sm text-muted-foreground">Buckets</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => (
          <Card
            key={plan.tier}
            className={currentTier === plan.tier ? "border-primary" : ""}
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{plan.name}</CardTitle>
                {currentTier === plan.tier && (
                  <Badge variant="secondary">Current</Badge>
                )}
              </div>
              <CardDescription>
                <span className="text-2xl font-bold text-foreground">
                  {plan.price}
                </span>
                {plan.price !== "Custom" && "/month"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-1.5">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm">
                    <Check className="h-3.5 w-3.5 text-primary" />
                    {f}
                  </li>
                ))}
              </ul>
              {plan.tier === "enterprise" ? (
                currentTier === "enterprise" ? null : (
                  <Button variant="outline" className="w-full" asChild>
                    <a href="mailto:hello@s3administrator.com">Contact Us</a>
                  </Button>
                )
              ) : currentTier === plan.tier ? (
                plan.tier !== "free" ? (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={handleManage}
                  >
                    Manage
                  </Button>
                ) : null
              ) : (
                <Button
                  className="w-full"
                  variant={plan.tier === "pro" ? "default" : "outline"}
                  onClick={() => handleUpgrade(plan.tier)}
                  disabled={upgrading !== null}
                >
                  {upgrading === plan.tier ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  {plan.tier === "free" ? "Downgrade" : "Upgrade"}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
