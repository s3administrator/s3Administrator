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

interface BillingSummaryData {
  activeSubscription: {
    id: string
    status: string
    planName: string
    planSlug: string
    priceMonthly: number
    currentPeriodStart: string
    currentPeriodEnd: string
    cancelAtPeriodEnd: boolean
  } | null
  nextPayment: {
    amountDue: number
    amountRemaining: number
    currency: string
    dueAt: string | null
    periodStart: string | null
    periodEnd: string | null
  } | null
  scheduledUpdate: {
    effectiveAt: string | null
    targetPlanId: string | null
    targetPlanName: string
    targetPlanSlug: string | null
    targetPriceMonthly: number | null
    currency: string | null
  } | null
  previousPayments: Array<{
    id: string
    number: string | null
    amountPaid: number
    currency: string
    paidAt: string | null
    hostedInvoiceUrl: string | null
    invoicePdf: string | null
    status: string | null
  }>
}

const EMPTY_BILLING_SUMMARY: BillingSummaryData = {
  activeSubscription: null,
  nextPayment: null,
  scheduledUpdate: null,
  previousPayments: [],
}

function formatPrice(cents: number): string {
  if (cents === 0) return "$0"
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

function formatCurrency(cents: number, currency: string | null | undefined): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency ?? "usd").toUpperCase(),
  }).format(cents / 100)
}

function formatLimit(n: number): string {
  if (n === 0) return "Unlimited"
  return n.toLocaleString()
}

function formatBucketLimit(plan: Pick<PlanData, "slug" | "bucketLimit">): string {
  if ((plan.slug === "pro" || plan.slug === "enterprise") && plan.bucketLimit >= 1000) {
    return "Unlimited"
  }
  return formatLimit(plan.bucketLimit)
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "N/A"
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function subscriptionStatusBadge(status: string, cancelAtPeriodEnd: boolean) {
  if (cancelAtPeriodEnd && status === "active") {
    return <Badge variant="secondary">Canceling</Badge>
  }

  switch (status) {
    case "active":
      return <Badge variant="default">Active</Badge>
    case "past_due":
      return <Badge variant="destructive">Past Due</Badge>
    case "trialing":
      return <Badge variant="outline">Trialing</Badge>
    case "canceled":
      return <Badge variant="secondary">Canceled</Badge>
    default:
      return <Badge variant="secondary">{status}</Badge>
  }
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

  const { data: billingSummary = EMPTY_BILLING_SUMMARY, isLoading: billingSummaryLoading } =
    useQuery<BillingSummaryData>({
      queryKey: ["billing-summary"],
      queryFn: async () => {
        const res = await fetch("/api/stripe/billing-summary")
        if (!res.ok) return EMPTY_BILLING_SUMMARY
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

      if (data.downgradedDeferred) {
        const effectiveDate = data.effectiveAt
          ? new Date(data.effectiveAt).toLocaleDateString()
          : "the end of your current billing period"
        toast.success(`Downgrade scheduled for ${effectiveDate}.`)
        queryClient.invalidateQueries({ queryKey: ["billing-summary"] })
      } else if (data.upgraded) {
        // Immediate upgrade/lateral plan change happened
        toast.success("Subscription updated! Changes may take a moment to reflect.")
        queryClient.invalidateQueries({ queryKey: ["usage"] })
        queryClient.invalidateQueries({ queryKey: ["billing-summary"] })
      } else if (data.url) {
        window.location.assign(data.url)
      } else {
        toast.error(data.error || "Failed to create checkout session")
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
        window.location.assign(data.url)
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

      {billingSummaryLoading ? (
        <div className="mb-6 grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="space-y-2">
                <div className="h-4 w-28 rounded bg-muted" />
                <div className="h-6 w-32 rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="h-3 w-40 rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <>
          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Subscription</CardTitle>
                <CardDescription>Current plan and cycle</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {billingSummary.activeSubscription ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{billingSummary.activeSubscription.planName}</span>
                      {subscriptionStatusBadge(
                        billingSummary.activeSubscription.status,
                        billingSummary.activeSubscription.cancelAtPeriodEnd,
                      )}
                    </div>
                    <p className="text-muted-foreground">
                      {billingSummary.activeSubscription.cancelAtPeriodEnd ? "Ends" : "Renews"}{" "}
                      {formatDate(billingSummary.activeSubscription.currentPeriodEnd)}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">You are currently on the free plan.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Next Payment</CardTitle>
                <CardDescription>Upcoming invoice estimate</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {billingSummary.nextPayment ? (
                  <>
                    <p className="text-2xl font-bold">
                      {formatCurrency(
                        billingSummary.nextPayment.amountDue,
                        billingSummary.nextPayment.currency,
                      )}
                    </p>
                    <p className="text-muted-foreground">
                      Due {formatDate(billingSummary.nextPayment.dueAt)}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">No upcoming payment.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Scheduled Update</CardTitle>
                <CardDescription>Changes planned for future billing cycles</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {billingSummary.scheduledUpdate ? (
                  <>
                    <p className="font-medium">{billingSummary.scheduledUpdate.targetPlanName}</p>
                    <p className="text-muted-foreground">
                      Effective {formatDate(billingSummary.scheduledUpdate.effectiveAt)}
                    </p>
                    {billingSummary.scheduledUpdate.targetPriceMonthly !== null ? (
                      <p className="text-muted-foreground">
                        {formatCurrency(
                          billingSummary.scheduledUpdate.targetPriceMonthly,
                          billingSummary.scheduledUpdate.currency,
                        )}
                        /month
                      </p>
                    ) : null}
                  </>
                ) : billingSummary.activeSubscription?.cancelAtPeriodEnd ? (
                  <p className="text-muted-foreground">
                    Subscription is set to cancel on{" "}
                    {formatDate(billingSummary.activeSubscription.currentPeriodEnd)}.
                  </p>
                ) : (
                  <p className="text-muted-foreground">No scheduled plan changes.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Previous Payments</CardTitle>
              <CardDescription>Latest paid invoices from Stripe</CardDescription>
            </CardHeader>
            <CardContent>
              {billingSummary.previousPayments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payments yet.</p>
              ) : (
                <div className="rounded-md border">
                  {billingSummary.previousPayments.map((payment) => {
                    const invoiceUrl = payment.hostedInvoiceUrl ?? payment.invoicePdf
                    return (
                      <div
                        key={payment.id}
                        className="flex flex-col gap-3 border-b p-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div>
                          <p className="text-sm font-medium">
                            {formatCurrency(payment.amountPaid, payment.currency)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(payment.paidAt)} · {payment.number ?? payment.id}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">Paid</Badge>
                          {invoiceUrl ? (
                            <Button variant="outline" size="sm" asChild>
                              <a href={invoiceUrl} target="_blank" rel="noreferrer">
                                View Invoice
                              </a>
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
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
                      {formatBucketLimit(plan)} bucket{plan.bucketLimit !== 1 ? "s" : ""}
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
