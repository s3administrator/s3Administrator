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
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { XCircle } from "lucide-react"

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

export default function AdminSubscriptionsPage() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)

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

  const cancelMutation = useMutation({
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
      toast.success("Subscription will cancel at end of billing period")
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to cancel"),
  })

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold sm:text-2xl">Subscriptions</h1>
        <p className="text-sm text-muted-foreground">
          {data?.total ?? 0} total subscriptions
        </p>
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
                      {sub.status !== "canceled" && !sub.cancelAtPeriodEnd && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (
                              confirm(
                                `Cancel subscription for ${sub.user.email}? They will keep access until ${new Date(sub.currentPeriodEnd).toLocaleDateString()}.`
                              )
                            ) {
                              cancelMutation.mutate(sub.id)
                            }
                          }}
                        >
                          <XCircle className="mr-1 h-4 w-4 text-destructive" />
                          Cancel
                        </Button>
                      )}
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
    </div>
  )
}
