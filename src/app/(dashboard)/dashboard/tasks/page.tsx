"use client"

import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ListTodo, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FolderPickerDialog } from "@/components/dashboard/folder-picker-dialog"
import { DestructiveConfirmDialog } from "@/components/shared/destructive-confirm-dialog"
import {
  DESTRUCTIVE_CONFIRM_SCOPE,
  hasDestructiveConfirmBypass,
} from "@/lib/destructive-confirmation"

type TaskScope = "folder" | "bucket"
type TaskOperation = "sync" | "copy" | "move" | "migrate"

interface Credential {
  id: string
  label: string
}

interface BucketOption {
  name: string
  credentialId: string
}

interface TaskRow {
  id: string
  title: string
  status: "pending" | "in_progress" | "completed" | "failed"
  updatedAt: string
}

interface TransferTaskCreateBody {
  scope: TaskScope
  operation: TaskOperation
  sourceBucket: string
  sourceCredentialId: string
  sourcePrefix?: string
  destinationBucket: string
  destinationCredentialId: string
  destinationPrefix?: string
}

function getStatusVariant(status: TaskRow["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default"
  if (status === "failed") return "destructive"
  if (status === "in_progress") return "secondary"
  return "outline"
}

const FOLDER_OPERATIONS: Array<{ value: TaskOperation; label: string }> = [
  { value: "sync", label: "Sync" },
  { value: "copy", label: "One-time copy" },
  { value: "move", label: "One-time move" },
]

const BUCKET_OPERATIONS: Array<{ value: TaskOperation; label: string }> = [
  { value: "sync", label: "Sync" },
  { value: "copy", label: "One-time copy" },
  { value: "migrate", label: "Migrate" },
]

export default function TasksPage() {
  const queryClient = useQueryClient()
  const [scope, setScope] = useState<TaskScope>("folder")
  const [operation, setOperation] = useState<TaskOperation>("sync")
  const [sourceCredentialId, setSourceCredentialId] = useState("")
  const [destinationCredentialId, setDestinationCredentialId] = useState("")
  const [sourceBucket, setSourceBucket] = useState("")
  const [destinationBucket, setDestinationBucket] = useState("")
  const [sourcePrefix, setSourcePrefix] = useState("")
  const [destinationPrefix, setDestinationPrefix] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [transferConfirmOpen, setTransferConfirmOpen] = useState(false)
  const [pendingTransferBody, setPendingTransferBody] = useState<TransferTaskCreateBody | null>(null)

  const { data: credentials = [] } = useQuery<Credential[]>({
    queryKey: ["credentials"],
    queryFn: async () => {
      const res = await fetch("/api/s3/credentials")
      if (!res.ok) return []
      return (await res.json()) as Credential[]
    },
  })

  const { data: buckets = [] } = useQuery<BucketOption[]>({
    queryKey: ["task-bucket-options", credentials.map((c) => c.id).sort().join(",")],
    enabled: credentials.length > 0,
    queryFn: async () => {
      const responses = await Promise.all(
        credentials.map(async (credential) => {
          const params = new URLSearchParams({ credentialId: credential.id })
          const res = await fetch(`/api/s3/buckets?${params}`)
          if (!res.ok) return [] as BucketOption[]
          const data = (await res.json()) as { buckets?: Array<{ name: string; credentialId: string }> }
          return (data.buckets ?? []).map((bucket) => ({
            name: bucket.name,
            credentialId: credential.id,
          }))
        })
      )
      return responses.flat()
    },
  })

  const { data: tasksData, refetch: refetchTasks } = useQuery<{ tasks: TaskRow[] }>({
    queryKey: ["background-tasks", "tasks-page"],
    queryFn: async () => {
      const res = await fetch("/api/tasks?scope=all&limit=20")
      if (!res.ok) return { tasks: [] }
      return (await res.json()) as { tasks: TaskRow[] }
    },
  })

  const availableOperations = scope === "folder" ? FOLDER_OPERATIONS : BUCKET_OPERATIONS
  const sourceBuckets = useMemo(
    () => buckets.filter((bucket) => bucket.credentialId === sourceCredentialId),
    [buckets, sourceCredentialId]
  )
  const destinationBuckets = useMemo(
    () => buckets.filter((bucket) => bucket.credentialId === destinationCredentialId),
    [buckets, destinationCredentialId]
  )

  useEffect(() => {
    if (!availableOperations.some((item) => item.value === operation)) {
      setOperation(availableOperations[0]?.value ?? "sync")
    }
  }, [availableOperations, operation])

  useEffect(() => {
    if (credentials.length === 0) return
    if (!sourceCredentialId) setSourceCredentialId(credentials[0].id)
    if (!destinationCredentialId) setDestinationCredentialId(credentials[0].id)
  }, [credentials, sourceCredentialId, destinationCredentialId])

  useEffect(() => {
    if (!sourceCredentialId) return
    if (!sourceBuckets.some((bucket) => bucket.name === sourceBucket)) {
      setSourceBucket(sourceBuckets[0]?.name ?? "")
    }
  }, [sourceBuckets, sourceCredentialId, sourceBucket])

  useEffect(() => {
    if (!destinationCredentialId) return
    if (!destinationBuckets.some((bucket) => bucket.name === destinationBucket)) {
      setDestinationBucket(destinationBuckets[0]?.name ?? "")
    }
  }, [destinationBuckets, destinationCredentialId, destinationBucket])

  useEffect(() => {
    setSourcePrefix("")
  }, [sourceCredentialId, sourceBucket])

  useEffect(() => {
    setDestinationPrefix("")
  }, [destinationCredentialId, destinationBucket])

  const destructiveTask = operation === "sync" || operation === "move" || operation === "migrate"

  function buildTransferTaskBody(): TransferTaskCreateBody | null {
    if (!sourceCredentialId || !destinationCredentialId) {
      toast.error("Select source and destination accounts")
      return null
    }
    if (!sourceBucket || !destinationBucket) {
      toast.error("Select source and destination buckets")
      return null
    }
    if (scope === "folder") {
      if (!sourcePrefix.trim() || !destinationPrefix.trim()) {
        toast.error("Source and destination folder prefixes are required")
        return null
      }
    }

    const body: TransferTaskCreateBody = {
      scope,
      operation,
      sourceBucket,
      sourceCredentialId,
      destinationBucket,
      destinationCredentialId,
    }

    if (scope === "folder") {
      body.sourcePrefix = sourcePrefix.trim()
      body.destinationPrefix = destinationPrefix.trim()
    }

    return body
  }

  async function createTransferTask(body: TransferTaskCreateBody) {
    setSubmitting(true)
    try {
      const res = await fetch("/api/tasks/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      const data = await res.json()
      if (!res.ok) {
        if (res.status === 403 && data?.details?.plan) {
          throw new Error(
            `${data.error} (resolved plan: ${data.details.plan}, source: ${data.details.planSource})`
          )
        }
        throw new Error(data?.error ?? "Failed to start task")
      }

      queryClient.invalidateQueries({ queryKey: ["background-tasks"] })
      void refetchTasks()
      toast.success("Task created")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start task")
      throw error
    } finally {
      setSubmitting(false)
    }
  }

  async function handleStartTask() {
    const body = buildTransferTaskBody()
    if (!body) return

    if (destructiveTask && !hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)) {
      setPendingTransferBody(body)
      setTransferConfirmOpen(true)
      return
    }

    try {
      await createTransferTask(body)
    } catch {
      // createTransferTask already handled toast
    }
  }

  async function handlePollTasks() {
    setPolling(true)
    try {
      for (let i = 0; i < 40; i++) {
        const res = await fetch("/api/tasks/process", { method: "POST" })
        if (!res.ok) break
        const data = await res.json()
        if (!data?.processed) break
      }
      queryClient.invalidateQueries({ queryKey: ["background-tasks"] })
      void refetchTasks()
    } finally {
      setPolling(false)
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ListTodo className="h-6 w-6" />
          Tasks
        </h1>
        <p className="text-sm text-muted-foreground">
          Start background tasks and track their execution status.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Available Task Types</CardTitle>
          <CardDescription>
            Folder scope supports sync/copy/move. Bucket scope supports sync/copy/migrate.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="flex h-full flex-col rounded-md border p-3">
            <p className="mb-2 text-sm font-medium">Between 2 folders (cross bucket possible)</p>
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              <li>Sync</li>
              <li>One-time copy</li>
              <li>One-time move</li>
            </ul>
          </div>
          <div className="flex h-full flex-col rounded-md border p-3">
            <p className="mb-2 text-sm font-medium">Between 2 buckets</p>
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              <li>Sync</li>
              <li>One-time copy</li>
              <li>Migrate</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle>Start New Task</CardTitle>
            <CardDescription>
              Transfers run on cached files only and follow plan limits. Sync tasks run continuously every
              minute until deleted. Sync now mirrors the destination scope and deletes destination-only files.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            onClick={() => void handlePollTasks()}
            disabled={polling}
            className="h-7 shrink-0 px-2 text-[11px] sm:h-8 sm:px-3 sm:text-xs"
          >
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${polling ? "animate-spin" : ""}`} />
            <span className="sm:hidden">Poll</span>
            <span className="hidden sm:inline">Process Queue</span>
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(value) => setScope(value as TaskScope)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="folder">Folder to folder</SelectItem>
                  <SelectItem value="bucket">Bucket to bucket</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Operation</Label>
              <Select value={operation} onValueChange={(value) => setOperation(value as TaskOperation)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableOperations.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Source account</Label>
              <Select value={sourceCredentialId} onValueChange={setSourceCredentialId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select source account" />
                </SelectTrigger>
                <SelectContent>
                  {credentials.map((credential) => (
                    <SelectItem key={credential.id} value={credential.id}>
                      {credential.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Destination account</Label>
              <Select value={destinationCredentialId} onValueChange={setDestinationCredentialId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select destination account" />
                </SelectTrigger>
                <SelectContent>
                  {credentials.map((credential) => (
                    <SelectItem key={credential.id} value={credential.id}>
                      {credential.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Source bucket</Label>
              <Select value={sourceBucket} onValueChange={setSourceBucket}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select source bucket" />
                </SelectTrigger>
                <SelectContent>
                  {sourceBuckets.map((bucket) => (
                    <SelectItem key={`${bucket.credentialId}:${bucket.name}`} value={bucket.name}>
                      {bucket.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Destination bucket</Label>
              <Select value={destinationBucket} onValueChange={setDestinationBucket}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select destination bucket" />
                </SelectTrigger>
                <SelectContent>
                  {destinationBuckets.map((bucket) => (
                    <SelectItem key={`${bucket.credentialId}:${bucket.name}`} value={bucket.name}>
                      {bucket.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {scope === "folder" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Source folder prefix</Label>
                <FolderPickerDialog
                  title="Pick Source Folder"
                  description="Select the source folder from cached paths."
                  credentialId={sourceCredentialId}
                  bucket={sourceBucket}
                  value={sourcePrefix}
                  onChange={setSourcePrefix}
                  disabled={!sourceCredentialId || !sourceBucket}
                />
              </div>
              <div className="space-y-2">
                <Label>Destination folder prefix</Label>
                <FolderPickerDialog
                  title="Pick Destination Folder"
                  description="Select the destination folder from cached paths."
                  credentialId={destinationCredentialId}
                  bucket={destinationBucket}
                  value={destinationPrefix}
                  onChange={setDestinationPrefix}
                  disabled={!destinationCredentialId || !destinationBucket}
                />
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => void handleStartTask()}
              disabled={submitting}
              className="w-full sm:w-auto"
            >
              {submitting ? "Starting..." : "Start Task"}
            </Button>
          </div>

          {destructiveTask ? (
            <p className="text-xs text-destructive">
              This operation can delete data. You will be asked to type confirmation unless bypass is active.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Tasks</CardTitle>
          <CardDescription>Task names and current status.</CardDescription>
        </CardHeader>
        <CardContent>
          {(tasksData?.tasks ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks yet.</p>
          ) : (
            <div className="space-y-2">
              {(tasksData?.tasks ?? []).map((task) => (
                <div key={task.id} className="relative rounded-md border px-3 py-2 pr-24">
                  <Badge
                    variant={getStatusVariant(task.status)}
                    className="absolute right-3 top-2 h-5 px-1.5 text-[10px] capitalize sm:h-6 sm:px-2 sm:text-xs"
                  >
                    {task.status.replace("_", " ")}
                  </Badge>
                  <p className="min-w-0 text-sm font-medium leading-5">{task.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(task.updatedAt).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <DestructiveConfirmDialog
        open={transferConfirmOpen}
        onOpenChange={(open) => {
          setTransferConfirmOpen(open)
          if (!open) {
            setPendingTransferBody(null)
          }
        }}
        title="Confirm destructive transfer"
        description={
          operation === "sync"
            ? "Sync mirrors destination to source scope and deletes destination-only files."
            : operation === "move" || operation === "migrate"
              ? "Move and migrate delete source objects after copying them to destination."
              : "This operation can delete objects."
        }
        actionLabel="Start Task"
        onConfirm={async () => {
          if (!pendingTransferBody) {
            throw new Error("Missing transfer payload")
          }
          await createTransferTask(pendingTransferBody)
          setPendingTransferBody(null)
        }}
      />
    </div>
  )
}
