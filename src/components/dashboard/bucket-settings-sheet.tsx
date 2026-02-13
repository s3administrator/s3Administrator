"use client"

import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { DestructiveConfirmDialog } from "@/components/shared/destructive-confirm-dialog"
import {
  DESTRUCTIVE_CONFIRM_SCOPE,
  hasDestructiveConfirmBypass,
} from "@/lib/destructive-confirmation"
import { PROVIDERS, type Provider } from "@/lib/providers"
import { Loader2, Trash2 } from "lucide-react"

interface BucketRef {
  name: string
  credentialId: string
}

interface BucketSettingCapability {
  supported: boolean
  reason?: string
}

interface BucketSettingsResponse {
  bucket: string
  credentialId: string
  credentialLabel: string
  provider: string
  capabilities: {
    cors: BucketSettingCapability
    versioning: BucketSettingCapability
    lifecycle: BucketSettingCapability
  }
  settings: {
    cors: {
      enabled: boolean
      allowedOrigins: string[]
      allowedMethods: string[]
      allowedHeaders: string[]
      exposeHeaders: string[]
      maxAgeSeconds: number
    }
    versioning: {
      status: "enabled" | "suspended" | "unversioned"
    }
    lifecycle: {
      enabled: boolean
      expirationDays: number | null
    }
  }
}

type SavingSection = "cors" | "versioning" | "lifecycle" | "delete" | null

function toMultiline(values: string[]): string {
  return values.join("\n")
}

function parseMultiline(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/g)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

function providerLabel(provider: string): string {
  const key = provider as Provider
  return PROVIDERS[key]?.name ?? provider
}

function capabilityError(capability: BucketSettingCapability): string {
  return capability.reason ?? "Not supported by this provider/API"
}

function SectionState({
  title,
  capability,
  children,
}: {
  title: string
  capability: BucketSettingCapability
  children: React.ReactNode
}) {
  return (
    <section className="rounded-md border p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {capability.supported ? (
          <Badge variant="outline">Supported</Badge>
        ) : (
          <Badge variant="secondary">Unavailable</Badge>
        )}
      </div>
      {!capability.supported ? (
        <p className="text-sm text-muted-foreground">{capabilityError(capability)}</p>
      ) : (
        children
      )}
    </section>
  )
}

export function BucketSettingsSheet({
  open,
  onOpenChange,
  bucket,
  onDeleted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  bucket: BucketRef | null
  onDeleted?: () => void | Promise<void>
}) {
  const queryClient = useQueryClient()
  const [savingSection, setSavingSection] = useState<SavingSection>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  const [corsEnabled, setCorsEnabled] = useState(false)
  const [allowedOriginsText, setAllowedOriginsText] = useState("")
  const [allowedMethodsText, setAllowedMethodsText] = useState("")
  const [allowedHeadersText, setAllowedHeadersText] = useState("")
  const [exposeHeadersText, setExposeHeadersText] = useState("")
  const [maxAgeSeconds, setMaxAgeSeconds] = useState("3600")

  const [versioningEnabled, setVersioningEnabled] = useState(false)
  const [lifecycleEnabled, setLifecycleEnabled] = useState(false)
  const [expirationDays, setExpirationDays] = useState("")

  const queryKey = useMemo(
    () => ["bucket-settings", bucket?.credentialId ?? "", bucket?.name ?? ""],
    [bucket?.credentialId, bucket?.name]
  )

  const { data, isLoading, refetch, isFetching } = useQuery<BucketSettingsResponse>({
    queryKey,
    enabled: open && Boolean(bucket?.name && bucket?.credentialId),
    queryFn: async () => {
      const params = new URLSearchParams({
        bucket: bucket?.name ?? "",
        credentialId: bucket?.credentialId ?? "",
      })
      const res = await fetch(`/api/s3/bucket-settings?${params.toString()}`)
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(payload?.error ?? "Failed to load bucket settings")
      }
      return payload as BucketSettingsResponse
    },
  })

  useEffect(() => {
    if (!data) return
    setCorsEnabled(data.settings.cors.enabled)
    setAllowedOriginsText(toMultiline(data.settings.cors.allowedOrigins))
    setAllowedMethodsText(toMultiline(data.settings.cors.allowedMethods))
    setAllowedHeadersText(toMultiline(data.settings.cors.allowedHeaders))
    setExposeHeadersText(toMultiline(data.settings.cors.exposeHeaders))
    setMaxAgeSeconds(String(data.settings.cors.maxAgeSeconds))

    setVersioningEnabled(data.settings.versioning.status === "enabled")
    setLifecycleEnabled(data.settings.lifecycle.enabled)
    setExpirationDays(data.settings.lifecycle.expirationDays ? String(data.settings.lifecycle.expirationDays) : "")
  }, [data])

  async function refreshRelevantQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["buckets"] }),
      queryClient.invalidateQueries({ queryKey: ["bucket-stats"] }),
      queryClient.invalidateQueries({ queryKey: ["bucket-settings"] }),
      queryClient.invalidateQueries({ queryKey: ["objects"] }),
    ])
  }

  async function patchBucketSettings(body: Record<string, unknown>, successMessage: string) {
    if (!bucket) return

    const res = await fetch("/api/s3/bucket-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket: bucket.name,
        credentialId: bucket.credentialId,
        ...body,
      }),
    })

    const payload = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(payload?.error ?? "Failed to save bucket settings")
    }

    toast.success(successMessage)
    await refreshRelevantQueries()
    await refetch()
  }

  async function handleSaveCors() {
    if (!bucket) return

    const parsedMaxAge = Number(maxAgeSeconds)
    if (!Number.isFinite(parsedMaxAge) || parsedMaxAge < 0) {
      toast.error("Max age must be a number greater than or equal to 0")
      return
    }

    const parsedOrigins = parseMultiline(allowedOriginsText)
    const parsedMethods = parseMultiline(allowedMethodsText)
    const parsedAllowedHeaders = parseMultiline(allowedHeadersText)
    const parsedExposeHeaders = parseMultiline(exposeHeadersText)

    if (corsEnabled && parsedOrigins.length === 0) {
      toast.error("At least one allowed origin is required when CORS is enabled")
      return
    }
    if (corsEnabled && parsedMethods.length === 0) {
      toast.error("At least one allowed method is required when CORS is enabled")
      return
    }

    setSavingSection("cors")
    try {
      await patchBucketSettings(
        {
          cors: {
            enabled: corsEnabled,
            allowedOrigins: parsedOrigins,
            allowedMethods: parsedMethods,
            allowedHeaders: parsedAllowedHeaders,
            exposeHeaders: parsedExposeHeaders,
            maxAgeSeconds: Math.floor(parsedMaxAge),
          },
        },
        "CORS settings updated"
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update CORS")
    } finally {
      setSavingSection(null)
    }
  }

  async function handleSaveVersioning() {
    if (!bucket) return

    setSavingSection("versioning")
    try {
      await patchBucketSettings(
        {
          versioning: {
            enabled: versioningEnabled,
          },
        },
        "Versioning settings updated"
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update versioning")
    } finally {
      setSavingSection(null)
    }
  }

  async function handleSaveLifecycle() {
    if (!bucket) return

    let normalizedExpirationDays: number | null = null
    if (lifecycleEnabled) {
      const parsedDays = Number(expirationDays)
      if (!Number.isFinite(parsedDays) || parsedDays < 1) {
        toast.error("Expiration days must be a number greater than or equal to 1")
        return
      }
      normalizedExpirationDays = Math.floor(parsedDays)
    }

    setSavingSection("lifecycle")
    try {
      await patchBucketSettings(
        {
          lifecycle: {
            enabled: lifecycleEnabled,
            expirationDays: normalizedExpirationDays,
          },
        },
        "Lifecycle settings updated"
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update lifecycle")
    } finally {
      setSavingSection(null)
    }
  }

  async function handleDeleteBucket() {
    if (!bucket) return

    setSavingSection("delete")
    try {
      const res = await fetch("/api/s3/buckets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket: bucket.name,
          credentialId: bucket.credentialId,
        }),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(payload?.error ?? "Failed to delete bucket")
      }

      toast.success("Bucket deleted")
      await refreshRelevantQueries()
      await onDeleted?.()
      setDeleteConfirmOpen(false)
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete bucket")
      throw error
    } finally {
      setSavingSection(null)
    }
  }

  const bucketLabel = data?.bucket ?? bucket?.name ?? ""
  const canDeleteDirectly = hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full p-0 sm:max-w-xl">
          <SheetHeader className="border-b p-4">
            <SheetTitle>Bucket Settings</SheetTitle>
            <SheetDescription>
              Manage provider-aware configuration for this bucket.
            </SheetDescription>
            {bucketLabel ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline">{bucketLabel}</Badge>
                {data?.credentialLabel ? (
                  <Badge variant="outline">{data.credentialLabel}</Badge>
                ) : null}
                {data?.provider ? (
                  <Badge variant="secondary">{providerLabel(data.provider)}</Badge>
                ) : null}
              </div>
            ) : null}
          </SheetHeader>

          <ScrollArea className="h-[calc(100vh-11rem)] px-4 py-4">
            {!bucket ? (
              <p className="text-sm text-muted-foreground">Select a bucket to manage settings.</p>
            ) : isLoading || isFetching ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : data ? (
              <div className="space-y-4 pb-4">
                <SectionState title="CORS" capability={data.capabilities.cors}>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={corsEnabled}
                        onCheckedChange={(checked) => setCorsEnabled(checked === true)}
                        aria-label="Enable CORS"
                      />
                      Enable managed CORS rule
                    </label>

                    <div className="space-y-1">
                      <Label htmlFor="bucket-cors-origins">Allowed origins</Label>
                      <textarea
                        id="bucket-cors-origins"
                        className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={allowedOriginsText}
                        onChange={(event) => setAllowedOriginsText(event.target.value)}
                        placeholder="https://app.example.com"
                      />
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="bucket-cors-methods">Allowed methods</Label>
                        <textarea
                          id="bucket-cors-methods"
                          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={allowedMethodsText}
                          onChange={(event) => setAllowedMethodsText(event.target.value)}
                          placeholder={"GET\nHEAD\nPUT"}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="bucket-cors-allowed-headers">Allowed headers</Label>
                        <textarea
                          id="bucket-cors-allowed-headers"
                          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={allowedHeadersText}
                          onChange={(event) => setAllowedHeadersText(event.target.value)}
                          placeholder="*"
                        />
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="bucket-cors-expose-headers">Expose headers</Label>
                        <textarea
                          id="bucket-cors-expose-headers"
                          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={exposeHeadersText}
                          onChange={(event) => setExposeHeadersText(event.target.value)}
                          placeholder="ETag"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="bucket-cors-max-age">Max age (seconds)</Label>
                        <Input
                          id="bucket-cors-max-age"
                          type="number"
                          min={0}
                          value={maxAgeSeconds}
                          onChange={(event) => setMaxAgeSeconds(event.target.value)}
                        />
                      </div>
                    </div>

                    <Button
                      type="button"
                      onClick={() => void handleSaveCors()}
                      disabled={savingSection !== null}
                    >
                      {savingSection === "cors" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Save CORS
                    </Button>
                  </div>
                </SectionState>

                <SectionState title="Versioning" capability={data.capabilities.versioning}>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={versioningEnabled}
                        onCheckedChange={(checked) => setVersioningEnabled(checked === true)}
                        aria-label="Enable versioning"
                      />
                      Enable bucket versioning
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Current status: {data.settings.versioning.status}
                    </p>
                    <Button
                      type="button"
                      onClick={() => void handleSaveVersioning()}
                      disabled={savingSection !== null}
                    >
                      {savingSection === "versioning" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Save Versioning
                    </Button>
                  </div>
                </SectionState>

                <SectionState title="Lifecycle" capability={data.capabilities.lifecycle}>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={lifecycleEnabled}
                        onCheckedChange={(checked) => setLifecycleEnabled(checked === true)}
                        aria-label="Enable lifecycle expiration"
                      />
                      Enable expiration rule
                    </label>

                    <div className="space-y-1">
                      <Label htmlFor="bucket-lifecycle-days">Expiration days</Label>
                      <Input
                        id="bucket-lifecycle-days"
                        type="number"
                        min={1}
                        disabled={!lifecycleEnabled}
                        value={expirationDays}
                        onChange={(event) => setExpirationDays(event.target.value)}
                        placeholder="30"
                      />
                    </div>

                    <Button
                      type="button"
                      onClick={() => void handleSaveLifecycle()}
                      disabled={savingSection !== null}
                    >
                      {savingSection === "lifecycle" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Save Lifecycle
                    </Button>
                  </div>
                </SectionState>

                <Separator />
                <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-sm font-semibold text-destructive">Danger Zone</p>
                  <p className="text-xs text-muted-foreground">
                    Deleting a bucket is allowed only when it is empty.
                  </p>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => {
                      if (canDeleteDirectly) {
                        void handleDeleteBucket()
                        return
                      }
                      setDeleteConfirmOpen(true)
                    }}
                    disabled={savingSection !== null}
                  >
                    {savingSection === "delete" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Delete Bucket
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load bucket settings.</p>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <DestructiveConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Confirm bucket deletion"
        description={
          bucket ? `Delete bucket "${bucket.name}"? This only works when the bucket is empty.` : "Delete bucket?"
        }
        actionLabel="Delete Bucket"
        onConfirm={handleDeleteBucket}
      />
    </>
  )
}
