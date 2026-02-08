"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { Plus, Trash2, Check, Loader2, Star } from "lucide-react"

interface Credential {
  id: string
  label: string
  endpoint: string
  region: string
  isDefault: boolean
  createdAt: string
}

const HETZNER_REGIONS = [
  { label: "Falkenstein (fsn1)", endpoint: "https://fsn1.your-objectstorage.com", region: "fsn1" },
  { label: "Nuremberg (nbg1)", endpoint: "https://nbg1.your-objectstorage.com", region: "nbg1" },
  { label: "Helsinki (hel1)", endpoint: "https://hel1.your-objectstorage.com", region: "hel1" },
]

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({
    label: "",
    endpoint: "",
    region: "",
    accessKey: "",
    secretKey: "",
  })
  const [testing, setTesting] = useState<string | null>(null)

  const { data: credentials, isLoading } = useQuery<Credential[]>({
    queryKey: ["credentials"],
    queryFn: async () => {
      const res = await fetch("/api/s3/credentials")
      if (!res.ok) return []
      return res.json()
    },
  })

  const addMutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const res = await fetch("/api/s3/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error("Failed to save credentials")
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credentials"] })
      queryClient.invalidateQueries({ queryKey: ["buckets"] })
      setAddOpen(false)
      setForm({ label: "", endpoint: "", region: "", accessKey: "", secretKey: "" })
      toast.success("Credentials saved")
    },
    onError: () => toast.error("Failed to save credentials"),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/s3/credentials?id=${id}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error("Failed to delete")
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credentials"] })
      queryClient.invalidateQueries({ queryKey: ["buckets"] })
      toast.success("Credentials deleted")
    },
  })

  const setDefaultMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/s3/credentials/default`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error("Failed to set default")
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credentials"] })
      queryClient.invalidateQueries({ queryKey: ["buckets"] })
      toast.success("Default credential updated")
    },
  })

  async function handleTest(id: string) {
    setTesting(id)
    try {
      const res = await fetch(`/api/s3/credentials/test?id=${id}`)
      if (res.ok) {
        toast.success("Connection successful")
      } else {
        toast.error("Connection failed")
      }
    } catch {
      toast.error("Connection failed")
    }
    setTesting(null)
  }

  function selectRegion(idx: number) {
    const region = HETZNER_REGIONS[idx]
    if (region) {
      setForm((f) => ({
        ...f,
        endpoint: region.endpoint,
        region: region.region,
        label: f.label || region.label,
      }))
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Manage your S3 credentials
          </p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Credential
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add S3 Credential</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                addMutation.mutate(form)
              }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label>Quick Select Region</Label>
                <div className="flex gap-2">
                  {HETZNER_REGIONS.map((r, i) => (
                    <Button
                      key={r.region}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => selectRegion(i)}
                    >
                      {r.region}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="label">Label</Label>
                <Input
                  id="label"
                  value={form.label}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, label: e.target.value }))
                  }
                  placeholder="My Hetzner Storage"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endpoint">Endpoint</Label>
                <Input
                  id="endpoint"
                  value={form.endpoint}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, endpoint: e.target.value }))
                  }
                  placeholder="https://fsn1.your-objectstorage.com"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="region">Region</Label>
                <Input
                  id="region"
                  value={form.region}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, region: e.target.value }))
                  }
                  placeholder="fsn1"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accessKey">Access Key</Label>
                <Input
                  id="accessKey"
                  value={form.accessKey}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, accessKey: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="secretKey">Secret Key</Label>
                <Input
                  id="secretKey"
                  type="password"
                  value={form.secretKey}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, secretKey: e.target.value }))
                  }
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={addMutation.isPending}
              >
                {addMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Save Credential
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <div className="h-12 animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : credentials && credentials.length > 0 ? (
        <div className="space-y-3">
          {credentials.map((cred) => (
            <Card key={cred.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base">{cred.label}</CardTitle>
                    {cred.isDefault && <Badge variant="secondary">Default</Badge>}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTest(cred.id)}
                      disabled={testing === cred.id}
                    >
                      {testing === cred.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                    </Button>
                    {!cred.isDefault && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDefaultMutation.mutate(cred.id)}
                      >
                        <Star className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteMutation.mutate(cred.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                <CardDescription>
                  {cred.endpoint} ({cred.region})
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No credentials yet. Add your first S3 credential to get started.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
