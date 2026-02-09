"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
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
import { toast } from "sonner"
import { Plus, Pencil, Trash2, Power, PowerOff } from "lucide-react"

interface Plan {
  id: string
  slug: string
  name: string
  priceMonthly: number
  stripePriceId: string | null
  bucketLimit: number
  fileLimit: number
  features: string[]
  thumbnailCache: boolean
  isActive: boolean
  sortOrder: number
  _count: { subscriptions: number }
}

function PlanForm({
  plan,
  onSuccess,
}: {
  plan?: Plan
  onSuccess: () => void
}) {
  const [slug, setSlug] = useState(plan?.slug ?? "")
  const [name, setName] = useState(plan?.name ?? "")
  const [priceDollars, setPriceDollars] = useState(
    plan ? (plan.priceMonthly / 100).toString() : "0"
  )
  const [bucketLimit, setBucketLimit] = useState(plan?.bucketLimit?.toString() ?? "1")
  const [fileLimit, setFileLimit] = useState(plan?.fileLimit?.toString() ?? "1000")
  const [features, setFeatures] = useState(plan?.features?.join("\n") ?? "")
  const [thumbnailCache, setThumbnailCache] = useState(plan?.thumbnailCache ?? false)
  const [sortOrder, setSortOrder] = useState(plan?.sortOrder?.toString() ?? "0")
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const body = {
        slug,
        name,
        priceMonthly: Math.round(parseFloat(priceDollars) * 100),
        bucketLimit: parseInt(bucketLimit, 10),
        fileLimit: parseInt(fileLimit, 10),
        features: features.split("\n").map((f) => f.trim()).filter(Boolean),
        thumbnailCache,
        sortOrder: parseInt(sortOrder, 10),
      }

      const url = plan ? `/api/admin/plans/${plan.id}` : "/api/admin/plans"
      const method = plan ? "PATCH" : "POST"

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? "Failed to save plan")
      }

      toast.success(plan ? "Plan updated" : "Plan created")
      onSuccess()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save plan")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="e.g. starter"
            disabled={!!plan}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Display Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Starter"
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor="price">Price ($/month)</Label>
          <Input
            id="price"
            type="number"
            step="0.01"
            min="0"
            value={priceDollars}
            onChange={(e) => setPriceDollars(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bucketLimit">Bucket Limit</Label>
          <Input
            id="bucketLimit"
            type="number"
            min="0"
            value={bucketLimit}
            onChange={(e) => setBucketLimit(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">0 = unlimited</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="fileLimit">File Limit</Label>
          <Input
            id="fileLimit"
            type="number"
            min="0"
            value={fileLimit}
            onChange={(e) => setFileLimit(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">0 = unlimited</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="features">Features (one per line)</Label>
          <textarea
            id="features"
            className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={features}
            onChange={(e) => setFeatures(e.target.value)}
            placeholder={"10 buckets\n10,000 cached files\nPriority support"}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sortOrder">Sort Order</Label>
          <Input
            id="sortOrder"
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
          <label className="mt-4 flex items-center gap-2 text-sm">
            <Checkbox
              checked={thumbnailCache}
              onCheckedChange={(checked) => setThumbnailCache(checked === true)}
              aria-label="Enable thumbnail cache"
            />
            Enable thumbnail cache
          </label>
        </div>
      </div>

      <Button type="submit" disabled={saving} className="w-full">
        {saving ? "Saving..." : plan ? "Update Plan" : "Create Plan"}
      </Button>
    </form>
  )
}

export default function AdminPlansPage() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [editPlan, setEditPlan] = useState<Plan | null>(null)

  const { data, isLoading } = useQuery<{ plans: Plan[] }>({
    queryKey: ["admin-plans"],
    queryFn: async () => {
      const res = await fetch("/api/admin/plans")
      if (!res.ok) throw new Error("Failed to load plans")
      return res.json()
    },
  })

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await fetch(`/api/admin/plans/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      })
      if (!res.ok) throw new Error("Failed to update plan")
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-plans"] })
      toast.success("Plan updated")
    },
    onError: () => toast.error("Failed to update plan"),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/plans/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? "Failed to delete plan")
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-plans"] })
      toast.success("Plan deleted")
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete plan"),
  })

  function handleFormSuccess() {
    setCreateOpen(false)
    setEditPlan(null)
    queryClient.invalidateQueries({ queryKey: ["admin-plans"] })
  }

  const plans = data?.plans ?? []

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Plans</h1>
          <p className="text-sm text-muted-foreground">
            Manage subscription plans. Stripe prices are created automatically.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Plan
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Plan</DialogTitle>
            </DialogHeader>
            <PlanForm onSuccess={handleFormSuccess} />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Limits</TableHead>
                <TableHead>Thumb Cache</TableHead>
                <TableHead>Subs</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell className="text-muted-foreground">{plan.sortOrder}</TableCell>
                  <TableCell className="font-mono text-xs">{plan.slug}</TableCell>
                  <TableCell className="font-medium">{plan.name}</TableCell>
                  <TableCell>
                    {plan.priceMonthly === 0
                      ? "Free"
                      : `$${(plan.priceMonthly / 100).toFixed(2)}/mo`}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {plan.bucketLimit === 0 ? "∞" : plan.bucketLimit} buckets,{" "}
                    {plan.fileLimit === 0 ? "∞" : plan.fileLimit.toLocaleString()} files
                  </TableCell>
                  <TableCell>
                    <Badge variant={plan.thumbnailCache ? "default" : "secondary"}>
                      {plan.thumbnailCache ? "On" : "Off"}
                    </Badge>
                  </TableCell>
                  <TableCell>{plan._count.subscriptions}</TableCell>
                  <TableCell>
                    <Badge variant={plan.isActive ? "default" : "secondary"}>
                      {plan.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          toggleMutation.mutate({
                            id: plan.id,
                            isActive: !plan.isActive,
                          })
                        }
                        title={plan.isActive ? "Deactivate" : "Activate"}
                      >
                        {plan.isActive ? (
                          <PowerOff className="h-4 w-4" />
                        ) : (
                          <Power className="h-4 w-4" />
                        )}
                      </Button>
                      <Dialog
                        open={editPlan?.id === plan.id}
                        onOpenChange={(open) => {
                          if (!open) setEditPlan(null)
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditPlan(plan)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-lg">
                          <DialogHeader>
                            <DialogTitle>Edit Plan: {plan.name}</DialogTitle>
                          </DialogHeader>
                          {editPlan && (
                            <PlanForm plan={editPlan} onSuccess={handleFormSuccess} />
                          )}
                        </DialogContent>
                      </Dialog>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (confirm(`Delete plan "${plan.name}"?`)) {
                            deleteMutation.mutate(plan.id)
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {plans.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    No plans yet. Create one to get started.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
