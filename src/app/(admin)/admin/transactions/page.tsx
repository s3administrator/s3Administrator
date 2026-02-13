"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
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
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { ExternalLink, Mail, Plus } from "lucide-react"

interface TransactionRow {
  id: string
  number: string | null
  status: string | null
  currency: string
  collectionMethod: string
  amountDue: number
  amountPaid: number
  amountRemaining: number
  createdAt: string
  dueDate: string | null
  hostedInvoiceUrl: string | null
  invoicePdf: string | null
  customer: {
    id: string | null
    email: string | null
    name: string | null
  }
  user: {
    id: string
    name: string | null
    email: string
  } | null
}

interface TransactionsResponse {
  transactions: TransactionRow[]
  hasMore: boolean
  nextCursor: string | null
}

function formatCurrency(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      maximumFractionDigits: 2,
    }).format(cents / 100)
  } catch {
    return `$${(cents / 100).toFixed(2)}`
  }
}

function canSendInvoice(tx: TransactionRow) {
  return tx.collectionMethod === "send_invoice" && (tx.status === "draft" || tx.status === "open")
}

function statusBadge(status: string | null) {
  if (status === "paid") return <Badge variant="default">Paid</Badge>
  if (status === "open") return <Badge variant="secondary">Open</Badge>
  if (status === "draft") return <Badge variant="outline">Draft</Badge>
  if (status === "void") return <Badge variant="secondary">Void</Badge>
  if (status === "uncollectible") return <Badge variant="destructive">Uncollectible</Badge>
  return <Badge variant="secondary">{status ?? "Unknown"}</Badge>
}

function SendInvoiceForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("")
  const [amountDollars, setAmountDollars] = useState("")
  const [description, setDescription] = useState("")
  const [dueInDays, setDueInDays] = useState("7")
  const [sending, setSending] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSending(true)

    try {
      const res = await fetch("/api/admin/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          amountDollars: Number(amountDollars),
          description: description.trim(),
          dueInDays: Number(dueInDays),
        }),
      })

      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to send invoice")
      }

      toast.success("Invoice sent")
      onSuccess()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send invoice")
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="invoice-email">Customer Email</Label>
        <Input
          id="invoice-email"
          type="email"
          placeholder="customer@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="invoice-amount">Amount (USD)</Label>
          <Input
            id="invoice-amount"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="49.00"
            value={amountDollars}
            onChange={(e) => setAmountDollars(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invoice-due">Due In (days)</Label>
          <Input
            id="invoice-due"
            type="number"
            min="1"
            max="90"
            value={dueInDays}
            onChange={(e) => setDueInDays(e.target.value)}
            required
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="invoice-description">Description</Label>
        <textarea
          id="invoice-description"
          className="flex min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Monthly consulting retainer"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
      </div>

      <Button type="submit" className="w-full" disabled={sending}>
        {sending ? "Sending..." : "Send Invoice"}
      </Button>
    </form>
  )
}

export default function AdminTransactionsPage() {
  const queryClient = useQueryClient()
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorHistory, setCursorHistory] = useState<string[]>([])
  const [createOpen, setCreateOpen] = useState(false)

  const { data, isLoading, error } = useQuery<TransactionsResponse>({
    queryKey: ["admin-transactions", cursor],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (cursor) params.set("cursor", cursor)
      const res = await fetch(`/api/admin/transactions${params.size ? `?${params.toString()}` : ""}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? "Failed to load transactions")
      }
      return res.json()
    },
  })

  const resendMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const res = await fetch(`/api/admin/transactions/${invoiceId}/send`, {
        method: "POST",
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(body?.error ?? "Failed to send invoice")
      }
      return body
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-transactions"] })
      toast.success("Invoice sent")
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to send invoice"),
  })

  function handleCreateSuccess() {
    setCreateOpen(false)
    queryClient.invalidateQueries({ queryKey: ["admin-transactions"] })
  }

  function handleNextPage() {
    if (!data?.hasMore || !data?.nextCursor) return
    setCursorHistory((prev) => [...prev, cursor ?? ""])
    setCursor(data.nextCursor)
  }

  function handlePrevPage() {
    if (cursorHistory.length === 0) return
    const prevCursor = cursorHistory[cursorHistory.length - 1]
    setCursorHistory((prev) => prev.slice(0, -1))
    setCursor(prevCursor || null)
  }

  const page = cursorHistory.length + 1
  const transactions = data?.transactions ?? []

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Transactions</h1>
          <p className="text-sm text-muted-foreground">
            Stripe invoices and manual billing actions
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              Send Invoice
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Send Invoice</DialogTitle>
            </DialogHeader>
            <SendInvoiceForm onSuccess={handleCreateSuccess} />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load transactions"}
        </div>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell>
                      <div>
                        <p className="font-mono text-xs">{tx.number ?? tx.id}</p>
                        <p className="text-xs text-muted-foreground">{tx.collectionMethod}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{tx.customer.name ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">{tx.customer.email ?? "No email"}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {tx.user ? (
                        <div>
                          <p>{tx.user.name ?? "—"}</p>
                          <p className="text-muted-foreground">{tx.user.email}</p>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Not linked</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>
                        <p className="font-medium">{formatCurrency(tx.amountDue, tx.currency)}</p>
                        <p className="text-muted-foreground">
                          Paid: {formatCurrency(tx.amountPaid, tx.currency)}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>{statusBadge(tx.status)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(tx.createdAt).toLocaleDateString("en-US", { timeZone: "UTC" })}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {tx.dueDate
                        ? new Date(tx.dueDate).toLocaleDateString("en-US", { timeZone: "UTC" })
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {canSendInvoice(tx) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => resendMutation.mutate(tx.id)}
                            disabled={resendMutation.isPending}
                          >
                            <Mail className="mr-1 h-4 w-4" />
                            Send
                          </Button>
                        )}
                        {tx.hostedInvoiceUrl && (
                          <a
                            href={tx.hostedInvoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                          >
                            View
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {transactions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      No transactions found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursorHistory.length === 0}
              onClick={handlePrevPage}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              {page}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.hasMore}
              onClick={handleNextPage}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
