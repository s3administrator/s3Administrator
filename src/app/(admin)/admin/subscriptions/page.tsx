"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DestructiveConfirmDialog } from "@/components/shared/destructive-confirm-dialog"
import { toast } from "sonner"
import { Pencil, Plus, Trash2 } from "lucide-react"
import {
  DESTRUCTIVE_CONFIRM_SCOPE,
  hasDestructiveConfirmBypass,
} from "@/lib/destructive-confirmation"

interface SubscriptionRow {
  id: string
  stripeSubscriptionId: string
  status: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  createdAt: string
  user: { id: string; name: string | null; email: string }
  plan: { id: string; name: string; slug: string }
}

interface PlanOption {
  id: string
  name: string
  slug: string
  priceMonthly: number
  stripePriceId: string | null
  isActive: boolean
}

interface SubscriptionFormPlanOption {
  id: string
  name: string
  slug: string
  priceMonthly: number
}

function statusBadge(status: string, cancelAtPeriodEnd: boolean) {
  if (cancelAtPeriodEnd && status === "active") {
    return <Badge variant="secondary">Canceling</Badge>
  }
  switch (status) {
    case "active":
      return <Badge variant="default">Active</Badge>
    case "canceled":
      return <Badge variant="secondary">Canceled</Badge>
    case "past_due":
      return <Badge variant="destructive">Past Due</Badge>
    case "trialing":
      return <Badge variant="outline">Trialing</Badge>
    default:
      return <Badge variant="secondary">{status}</Badge>
  }
}

function formatPlanLabel(plan: SubscriptionFormPlanOption) {
  if (plan.priceMonthly > 0) {
    return `${plan.name} (${plan.slug}) - $${(plan.priceMonthly / 100).toFixed(2)}/mo`
  }
  return `${plan.name} (${plan.slug})`
}

function CreateSubscriptionForm({
  plans,
  onSuccess,
}: {
  plans: SubscriptionFormPlanOption[]
  onSuccess: () => void
}) {
  const [userEmail, setUserEmail] = useState("")
  const [planId, setPlanId] = useState(plans[0]?.id ?? "")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!planId && plans.length > 0) {
      setPlanId(plans[0].id)
    }
  }, [planId, plans])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!planId) {
      toast.error("Select a plan")
      return
    }

    setSaving(true)
    try {
      const res = await fetch("/api/admin/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userEmail: userEmail.trim(),
          planId,
        }),
      })

      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to create subscription")
      }

      toast.success(data?.mode === "updated" ? "Existing subscription updated" : "Subscription created")
      onSuccess()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create subscription")
    } finally {
      setSaving(false)
    }
  }

  if (plans.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No active paid plans are available. Create or activate one in Plans first.
      </p>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="userEmail">User Email</Label>
        <Input
          id="userEmail"
          type="email"
          placeholder="user@example.com"
          value={userEmail}
          onChange={(e) => setUserEmail(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="plan">Plan</Label>
        <Select value={planId} onValueChange={setPlanId}>
          <SelectTrigger id="plan">
            <SelectValue placeholder="Select plan" />
          </SelectTrigger>
          <SelectContent>
            {plans.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {formatPlanLabel(plan)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button type="submit" className="w-full" disabled={saving}>
        {saving ? "Saving..." : "Create Subscription"}
      </Button>
    </form>
  )
}

function EditSubscriptionForm({
  subscription,
  plans,
  onSuccess,
}: {
  subscription: SubscriptionRow
  plans: SubscriptionFormPlanOption[]
  onSuccess: () => void
}) {
  const selectablePlans = useMemo(() => {
    if (plans.some((plan) => plan.id === subscription.plan.id)) {
      return plans
    }
    return [
      {
        id: subscription.plan.id,
        name: `${subscription.plan.name} (current)`,
        slug: subscription.plan.slug,
        priceMonthly: 0,
      },
      ...plans,
    ]
  }, [plans, subscription.plan.id, subscription.plan.name, subscription.plan.slug])

  const [planId, setPlanId] = useState(subscription.plan.id)
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(subscription.cancelAtPeriodEnd)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!selectablePlans.some((plan) => plan.id === planId) && selectablePlans.length > 0) {
      setPlanId(selectablePlans[0].id)
    }
  }, [planId, selectablePlans])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const body: { planId?: string; cancelAtPeriodEnd?: boolean } = {}
    if (planId !== subscription.plan.id) body.planId = planId
    if (cancelAtPeriodEnd !== subscription.cancelAtPeriodEnd) {
      body.cancelAtPeriodEnd = cancelAtPeriodEnd
    }

    if (Object.keys(body).length === 0) {
      toast.info("No changes to save")
      return
    }

    setSaving(true)
    try {
      const res = await fetch(`/api/admin/subscriptions/${subscription.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to update subscription")
      }

      toast.success("Subscription updated")
      onSuccess()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update subscription")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`plan-${subscription.id}`}>Plan</Label>
        <Select value={planId} onValueChange={setPlanId}>
          <SelectTrigger id={`plan-${subscription.id}`}>
            <SelectValue placeholder="Select plan" />
          </SelectTrigger>
          <SelectContent>
            {selectablePlans.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {formatPlanLabel(plan)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={cancelAtPeriodEnd}
          onCheckedChange={(checked) => setCancelAtPeriodEnd(checked === true)}
          aria-label="Cancel at period end"
        />
        Cancel at period end
      </label>

      <Button type="submit" className="w-full" disabled={saving}>
        {saving ? "Saving..." : "Update Subscription"}
      </Button>
    </form>
  )
}

export default function AdminSubscriptionsPage() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [editSubscription, setEditSubscription] = useState<SubscriptionRow | null>(null)
  const [pendingDeleteSubscription, setPendingDeleteSubscription] = useState<SubscriptionRow | null>(null)

  const { data, isLoading } = useQuery<{
    subscriptions: SubscriptionRow[]
    total: number
    limit: number
  }>({
    queryKey: ["admin-subscriptions", page],
    queryFn: async () => {
      const res = await fetch(`/api/admin/subscriptions?page=${page}`)
      if (!res.ok) throw new Error("Failed to load subscriptions")
      return res.json()
    },
  })

  const { data: planData, isLoading: plansLoading } = useQuery<{ plans: PlanOption[] }>({
    queryKey: ["admin-subscription-plan-options"],
    queryFn: async () => {
      const res = await fetch("/api/admin/plans")
      if (!res.ok) throw new Error("Failed to load plans")
      return res.json()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/subscriptions/${id}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? "Failed to cancel subscription")
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-subscriptions"] })
      queryClient.invalidateQueries({ queryKey: ["admin-users"] })
      toast.success("Subscription deleted")
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to delete subscription"),
  })

  function handleFormSuccess() {
    setCreateOpen(false)
    setEditSubscription(null)
    queryClient.invalidateQueries({ queryKey: ["admin-subscriptions"] })
    queryClient.invalidateQueries({ queryKey: ["admin-users"] })
  }

  const assignablePlans = useMemo<SubscriptionFormPlanOption[]>(
    () =>
      (planData?.plans ?? [])
        .filter((plan) => plan.isActive && !!plan.stripePriceId)
        .map((plan) => ({
          id: plan.id,
          name: plan.name,
          slug: plan.slug,
          priceMonthly: plan.priceMonthly,
        })),
    [planData?.plans]
  )

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Subscriptions</h1>
          <p className="text-sm text-muted-foreground">
            {data?.total ?? 0} total subscriptions
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button
              className="w-full sm:w-auto"
              disabled={plansLoading || assignablePlans.length === 0}
            >
              <Plus className="mr-2 h-4 w-4" />
              Create Subscription
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Subscription</DialogTitle>
            </DialogHeader>
            <CreateSubscriptionForm plans={assignablePlans} onSuccess={handleFormSuccess} />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Period End</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.subscriptions.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{sub.user.name ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">
                          {sub.user.email}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{sub.plan.name}</Badge>
                    </TableCell>
                    <TableCell>
                      {statusBadge(sub.status, sub.cancelAtPeriodEnd)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(sub.currentPeriodEnd).toLocaleDateString("en-US", {
                        timeZone: "UTC",
                      })}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(sub.createdAt).toLocaleDateString("en-US", {
                        timeZone: "UTC",
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {sub.status !== "canceled" && (
                          <Dialog
                            open={editSubscription?.id === sub.id}
                            onOpenChange={(open) => {
                              if (!open) setEditSubscription(null)
                            }}
                          >
                            <DialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditSubscription(sub)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="sm:max-w-lg">
                              <DialogHeader>
                                <DialogTitle>Edit Subscription</DialogTitle>
                              </DialogHeader>
                              {editSubscription && (
                                <EditSubscriptionForm
                                  subscription={editSubscription}
                                  plans={assignablePlans}
                                  onSuccess={handleFormSuccess}
                                />
                              )}
                            </DialogContent>
                          </Dialog>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)) {
                              deleteMutation.mutate(sub.id)
                              return
                            }

                            setPendingDeleteSubscription(sub)
                          }}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {(data?.subscriptions.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-muted-foreground"
                    >
                      No subscriptions yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <DestructiveConfirmDialog
        open={Boolean(pendingDeleteSubscription)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteSubscription(null)
          }
        }}
        title="Confirm subscription deletion"
        description={
          pendingDeleteSubscription
            ? pendingDeleteSubscription.status === "canceled"
              ? `Clean up canceled subscription for ${pendingDeleteSubscription.user.email}? This removes the local record.`
              : `Delete subscription for ${pendingDeleteSubscription.user.email}? This cancels billing immediately and removes the local record.`
            : "Delete subscription?"
        }
        actionLabel="Delete Subscription"
        onConfirm={async () => {
          if (!pendingDeleteSubscription) {
            throw new Error("Missing subscription context")
          }
          await deleteMutation.mutateAsync(pendingDeleteSubscription.id)
          setPendingDeleteSubscription(null)
        }}
      />
    </div>
  )
}
