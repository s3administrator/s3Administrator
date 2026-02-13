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
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DestructiveConfirmDialog } from "@/components/shared/destructive-confirm-dialog"
import { toast } from "sonner"
import { Trash2 } from "lucide-react"
import {
  DESTRUCTIVE_CONFIRM_SCOPE,
  hasDestructiveConfirmBypass,
} from "@/lib/destructive-confirmation"

interface AdminUser {
  id: string
  name: string | null
  email: string
  role: string
  tier: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  createdAt: string
  _count: { s3Credentials: number; fileMetadata: number }
}

export default function AdminUsersPage() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [pendingDeleteUser, setPendingDeleteUser] = useState<AdminUser | null>(null)

  const { data, isLoading } = useQuery<{
    users: AdminUser[]
    total: number
    limit: number
  }>({
    queryKey: ["admin-users", page],
    queryFn: async () => {
      const res = await fetch(`/api/admin/users?page=${page}`)
      if (!res.ok) throw new Error("Failed to load users")
      return res.json()
    },
  })

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      tier,
      role,
    }: {
      id: string
      tier?: string
      role?: string
    }) => {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, role }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? "Failed to update user")
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] })
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] })
      toast.success("User updated")
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to update user"),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? "Failed to delete user")
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] })
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] })
      toast.success("User deleted")
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to delete user"),
  })

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold sm:text-2xl">Users</h1>
        <p className="text-sm text-muted-foreground">
          {data?.total ?? 0} total users
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
                  <TableHead>Role</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Credentials</TableHead>
                  <TableHead>Files</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{user.name ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">
                          {user.email}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={user.role}
                        onValueChange={(role) =>
                          updateMutation.mutate({ id: user.id, role })
                        }
                      >
                        <SelectTrigger className="h-8 w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="user">user</SelectItem>
                          <SelectItem value="admin">admin</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={user.tier}
                        onValueChange={(tier) =>
                          updateMutation.mutate({ id: user.id, tier })
                        }
                      >
                        <SelectTrigger className="h-8 w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="free">free</SelectItem>
                          <SelectItem value="starter">starter</SelectItem>
                          <SelectItem value="pro">pro</SelectItem>
                          <SelectItem value="enterprise">enterprise</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>{user._count.s3Credentials}</TableCell>
                    <TableCell>{user._count.fileMetadata}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(user.createdAt).toLocaleDateString("en-US", {
                        timeZone: "UTC",
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)) {
                            deleteMutation.mutate(user.id)
                            return
                          }

                          setPendingDeleteUser(user)
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
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
        open={Boolean(pendingDeleteUser)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteUser(null)
          }
        }}
        title="Confirm user deletion"
        description={
          pendingDeleteUser
            ? `Delete user \"${pendingDeleteUser.email}\"? This cancels subscriptions and removes all user data.`
            : "Delete user?"
        }
        actionLabel="Delete User"
        onConfirm={async () => {
          if (!pendingDeleteUser) {
            throw new Error("Missing user context")
          }
          await deleteMutation.mutateAsync(pendingDeleteUser.id)
          setPendingDeleteUser(null)
        }}
      />
    </div>
  )
}
