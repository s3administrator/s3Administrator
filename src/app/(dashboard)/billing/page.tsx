"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
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

interface PlanData {
  id: string
  slug: string
  name: string
  priceMonthly: number
  bucketLimit: number
  fileLimit: number
  features: string[]
  stripePriceId: string | null
}

function formatPrice(cents: number): string {
  if (cents === 0) return "$0"
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

function formatLimit(n: number): string {
  if (n === 0) return "Unlimited"
  return n.toLocaleString()
}

export default function BillingPage() {
  const queryClient = useQueryClient()
  const [upgrading, setUpgrading] = useState<string | null>(null)

  const { data: plans = [], isLoading: plansLoading } = useQuery<PlanData[]>({
    queryKey: ["plans"],
    queryFn: async () => {
      const res = await fetch("/api/plans")
      if (!res.ok) return []
      const data = await res.json()
      return data.plans ?? []
    },
  })

  const { data: usage } = useQuery({
    queryKey: ["usage"],
    queryFn: async () => {
      const res = await fetch("/api/s3/usage")
      if (!res.ok) return { tier: "free", fileCount: 0, bucketCount: 0 }
      return res.json()
    },
  })

  const currentTier = usage?.tier || "free"

  async function handleSubscribe(plan: PlanData) {
    if (plan.slug === currentTier) return

    // Free plan — redirect to portal to cancel existing subscription
    if (!plan.stripePriceId) {
      return handleManage()
    }

    // Contact-us plan — open email
    if (isContactPlan(plan)) return

    setUpgrading(plan.id)
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      })
      const data = await res.json()

      if (data.upgraded) {
        // In-place upgrade/downgrade happened
        toast.success("Subscription updated! Changes may take a moment to reflect.")
        queryClient.invalidateQueries({ queryKey: ["usage"] })
      } else if (data.url) {
        window.location.href = data.url
      } else {
        toast.error("Failed to create checkout session")
      }
    } catch {
      toast.error("Failed to process subscription change")
    }
    setUpgrading(null)
  }

  async function handleManage() {
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        toast.error(data.error || "Failed to open billing portal")
      }
    } catch {
      toast.error("Failed to open billing portal")
    }
  }

  function isContactPlan(plan: PlanData): boolean {
    return plan.priceMonthly === 0 && !plan.stripePriceId && plan.slug !== "free"
  }

  function getButtonLabel(plan: PlanData): string {
    if (plan.slug === currentTier) return "Current Plan"
    if (isContactPlan(plan)) return "Contact Us"

    const currentIdx = plans.findIndex((p) => p.slug === currentTier)
    const targetIdx = plans.findIndex((p) => p.id === plan.id)

    return targetIdx > currentIdx ? "Upgrade" : "Downgrade"
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

      {plansLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="space-y-2">
                <div className="h-4 w-20 rounded bg-muted" />
                <div className="h-8 w-16 rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="h-3 w-full rounded bg-muted" />
                  <div className="h-3 w-3/4 rounded bg-muted" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div
          className="grid gap-4 sm:grid-cols-2"
          style={{
            gridTemplateColumns: `repeat(${Math.min(plans.length, 4)}, minmax(0, 1fr))`,
          }}
        >
          {plans.map((plan) => {
            const isCurrent = currentTier === plan.slug
            return (
              <Card
                key={plan.id}
                className={`flex flex-col ${isCurrent ? "border-primary" : ""}`}
              >
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{plan.name}</CardTitle>
                    {isCurrent && <Badge variant="secondary">Current</Badge>}
                  </div>
                  <CardDescription>
                    <span className="text-2xl font-bold text-foreground">
                      {isContactPlan(plan)
                        ? "Custom"
                        : plan.priceMonthly === 0
                          ? "Free"
                          : formatPrice(plan.priceMonthly)}
                    </span>
                    {plan.priceMonthly > 0 && "/month"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  <ul className="space-y-1.5">
                    <li className="flex items-center gap-2 text-sm">
                      <Check className="h-3.5 w-3.5 text-primary" />
                      {formatLimit(plan.bucketLimit)} bucket{plan.bucketLimit !== 1 ? "s" : ""}
                    </li>
                    <li className="flex items-center gap-2 text-sm">
                      <Check className="h-3.5 w-3.5 text-primary" />
                      {formatLimit(plan.fileLimit)} cached files
                    </li>
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-sm">
                        <Check className="h-3.5 w-3.5 text-primary" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto pt-4">
                    {isCurrent ? (
                      plan.stripePriceId ? (
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={handleManage}
                        >
                          Manage
                        </Button>
                      ) : null
                    ) : isContactPlan(plan) ? (
                      <Button
                        className="w-full"
                        variant="outline"
                        asChild
                      >
                        <a href="mailto:hello@s3administrator.com">Contact Us</a>
                      </Button>
                    ) : (
                      <Button
                        className="w-full"
                        variant={plan.stripePriceId ? "default" : "outline"}
                        onClick={() => handleSubscribe(plan)}
                        disabled={upgrading !== null}
                      >
                        {upgrading === plan.id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        {getButtonLabel(plan)}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
