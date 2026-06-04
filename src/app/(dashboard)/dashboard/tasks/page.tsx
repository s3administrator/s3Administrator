"use client"

import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { AlertTriangle, ListTodo, Pause, Play, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
  type: string
  title: string
  status: "pending" | "in_progress" | "completed" | "failed" | "canceled"
  progress: unknown
  lifecycleState: "active" | "paused" | "canceled"
  lastError: string | null
  runCount: number
  isRecurring: boolean
  scheduleCron?: string | null
  scheduleIntervalSeconds: number | null
  nextRunAt: string
  lastRunAt: string | null
  upcomingRuns: string[]
  lastRunStatus: string | null
  lastRunDurationMs: number | null
  successRuns: number
  failedRuns: number
  executionHistory: Array<{
    at: string
    status: "succeeded" | "failed" | "skipped" | "paused" | "resumed" | "restarted"
    message: string
  }>
  createdAt: string
  completedAt: string | null
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

interface TransferTaskPreview {
  type: "object_transfer"
  summary: string[]
  commands: string[]
  estimatedObjects: number
  sampleObjects: string[]
  warnings: string[]
  detailedPlan: TransferTaskDetailedPreviewPlan
}

interface TransferTaskDetailedPreviewAction {
  phase: "transfer" | "sync_cleanup"
  operation: "copy" | "skip" | "delete_source" | "delete_destination"
  command: string
  sourceKey: string | null
  destinationKey: string | null
  reason?: string
}

interface TransferTaskDetailedPreviewActionCounts {
  copy: number
  skip: number
  delete_source: number
  delete_destination: number
}

interface TransferTaskDetailedPreviewCursor {
  phase: "source" | "cleanup"
  sourceKey: string | null
  cleanupKey: string | null
}

interface TransferTaskDetailedPreviewPlan {
  actions: TransferTaskDetailedPreviewAction[]
  hasMore: boolean
  nextCursor: TransferTaskDetailedPreviewCursor | null
  pageSize: number
  scannedSourceObjects: number
  scanLimitReached: boolean
  actionCounts: TransferTaskDetailedPreviewActionCounts
  totalCounts: TransferTaskDetailedPreviewActionCounts | null
}

type TransferProgressStage =
  | "queued"
  | "copying"
  | "deleting_source"
  | "finalizing"
  | "completed"
  | "failed"

type TransferStrategy =
  | "single_request_server_copy"
  | "multipart_server_copy"
  | "multipart_relay_upload"

interface TransferLiveProgress {
  currentFileKey: string | null
  currentFileSizeBytes: bigint | null
  currentFileTransferredBytes: bigint | null
  currentFileStage: TransferProgressStage | null
  transferStrategy: TransferStrategy | null
  fallbackReason: string | null
  bytesProcessedTotal: bigint | null
  bytesEstimatedTotal: bigint | null
  throughputBytesPerSec: number | null
  etaSeconds: number | null
  lastProgressAt: string | null
}

function toSafeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function toSafeBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value >= BigInt(0) ? value : null
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null
    return BigInt(Math.floor(value))
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = BigInt(value)
      return parsed >= BigInt(0) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

function formatBytes(bytes: bigint | null): string {
  if (bytes === null) return "n/a"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = Number(bytes)
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

function formatEtaSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "n/a"
  const rounded = Math.max(0, Math.floor(seconds))
  if (rounded < 60) return `${rounded}s`
  const minutes = Math.floor(rounded / 60)
  const remainingSeconds = rounded % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function formatTransferStage(stage: TransferProgressStage | null): string {
  if (!stage) return "idle"
  return stage.replace("_", " ")
}

function formatTransferStrategy(strategy: TransferStrategy | null): string {
  if (!strategy) return "unknown"
  if (strategy === "single_request_server_copy") return "server copy"
  if (strategy === "multipart_server_copy") return "multipart server copy"
  return "relay upload"
}

function parseTransferLiveProgress(progress: unknown): TransferLiveProgress | null {
  if (!progress || typeof progress !== "object") return null
  const candidate = progress as {
    currentFileKey?: unknown
    currentFileSizeBytes?: unknown
    currentFileTransferredBytes?: unknown
    currentFileStage?: unknown
    transferStrategy?: unknown
    fallbackReason?: unknown
    bytesProcessedTotal?: unknown
    bytesEstimatedTotal?: unknown
    throughputBytesPerSec?: unknown
    etaSeconds?: unknown
    lastProgressAt?: unknown
  }

  const stage: TransferProgressStage | null =
    candidate.currentFileStage === "queued" ||
    candidate.currentFileStage === "copying" ||
    candidate.currentFileStage === "deleting_source" ||
    candidate.currentFileStage === "finalizing" ||
    candidate.currentFileStage === "completed" ||
    candidate.currentFileStage === "failed"
      ? candidate.currentFileStage
      : null

  const strategy: TransferStrategy | null =
    candidate.transferStrategy === "single_request_server_copy" ||
    candidate.transferStrategy === "multipart_server_copy" ||
    candidate.transferStrategy === "multipart_relay_upload"
      ? candidate.transferStrategy
      : null

  return {
    currentFileKey:
      typeof candidate.currentFileKey === "string" && candidate.currentFileKey.trim().length > 0
        ? candidate.currentFileKey
        : null,
    currentFileSizeBytes: toSafeBigInt(candidate.currentFileSizeBytes),
    currentFileTransferredBytes: toSafeBigInt(candidate.currentFileTransferredBytes),
    currentFileStage: stage,
    transferStrategy: strategy,
    fallbackReason:
      typeof candidate.fallbackReason === "string" && candidate.fallbackReason.trim().length > 0
        ? candidate.fallbackReason
        : null,
    bytesProcessedTotal: toSafeBigInt(candidate.bytesProcessedTotal),
    bytesEstimatedTotal: toSafeBigInt(candidate.bytesEstimatedTotal),
    throughputBytesPerSec:
      typeof candidate.throughputBytesPerSec === "number" && Number.isFinite(candidate.throughputBytesPerSec)
        ? Math.max(0, candidate.throughputBytesPerSec)
        : null,
    etaSeconds:
      typeof candidate.etaSeconds === "number" && Number.isFinite(candidate.etaSeconds)
        ? Math.max(0, Math.floor(candidate.etaSeconds))
        : null,
    lastProgressAt:
      typeof candidate.lastProgressAt === "string" && candidate.lastProgressAt.trim().length > 0
        ? candidate.lastProgressAt
        : null,
  }
}

interface ProgressEventView {
  sourceKey: string
  destinationKey: string
  stage: string
  strategy: string
  transferredBytes: bigint | null
  totalBytes: bigint | null
  throughputBytesPerSec: number | null
  etaSeconds: number | null
  sampleReason: string | null
}

function parseProgressEventView(metadata: unknown): ProgressEventView | null {
  if (!metadata || typeof metadata !== "object") return null
  const candidate = metadata as {
    sourceKey?: unknown
    destinationKey?: unknown
    stage?: unknown
    strategy?: unknown
    transferredBytes?: unknown
    totalBytes?: unknown
    throughputBytesPerSec?: unknown
    etaSeconds?: unknown
    sampleReason?: unknown
  }

  if (typeof candidate.sourceKey !== "string" || candidate.sourceKey.trim().length === 0) {
    return null
  }

  return {
    sourceKey: candidate.sourceKey,
    destinationKey:
      typeof candidate.destinationKey === "string" && candidate.destinationKey.trim().length > 0
        ? candidate.destinationKey
        : "-",
    stage: typeof candidate.stage === "string" ? candidate.stage : "copying",
    strategy: typeof candidate.strategy === "string" ? candidate.strategy : "unknown",
    transferredBytes: toSafeBigInt(candidate.transferredBytes),
    totalBytes: toSafeBigInt(candidate.totalBytes),
    throughputBytesPerSec:
      typeof candidate.throughputBytesPerSec === "number" &&
      Number.isFinite(candidate.throughputBytesPerSec)
        ? Math.max(0, candidate.throughputBytesPerSec)
        : null,
    etaSeconds:
      typeof candidate.etaSeconds === "number" && Number.isFinite(candidate.etaSeconds)
        ? Math.max(0, Math.floor(candidate.etaSeconds))
        : null,
    sampleReason:
      typeof candidate.sampleReason === "string" && candidate.sampleReason.trim().length > 0
        ? candidate.sampleReason
        : null,
  }
}

function getTransferResultSummary(progress: unknown): string | null {
  if (!progress || typeof progress !== "object") return null
  const candidate = progress as {
    total?: unknown
    processed?: unknown
    copied?: unknown
    moved?: unknown
    failed?: unknown
    skipped?: unknown
  }
  const processed = toSafeInt(candidate.processed)
  const copied = toSafeInt(candidate.copied)
  const moved = toSafeInt(candidate.moved)
  const failed = toSafeInt(candidate.failed)
  const skipped = toSafeInt(candidate.skipped)
  const total = toSafeInt(candidate.total)

  if (processed <= 0 && failed <= 0 && copied <= 0 && moved <= 0) return null

  const effectiveCopied = copied > 0 || moved > 0 ? copied + moved : Math.max(0, processed - failed - skipped)
  const parts = [
    `${effectiveCopied.toLocaleString()} copied`,
  ]
  if (skipped > 0) {
    parts.push(`${skipped.toLocaleString()} skipped`)
  }
  if (failed > 0) {
    parts.push(`${failed.toLocaleString()} failed`)
  }
  if (total > 0) {
    parts.push(`${total.toLocaleString()} total`)
  }
  return parts.join(" • ")
}

function getBulkDeleteResultSummary(progress: unknown): string | null {
  if (!progress || typeof progress !== "object") return null
  const candidate = progress as {
    total?: unknown
    deleted?: unknown
    remaining?: unknown
  }
  const total = toSafeInt(candidate.total)
  const deleted = toSafeInt(candidate.deleted)
  const remaining = toSafeInt(candidate.remaining)
  if (total <= 0 && deleted <= 0) return null
  if (remaining > 0) {
    return `${deleted.toLocaleString()} deleted • ${remaining.toLocaleString()} remaining`
  }
  return `${deleted.toLocaleString()} deleted`
}

function getTaskResultSummary(task: TaskRow): string | null {
  if (task.type === "object_transfer") {
    return getTransferResultSummary(task.progress)
  }
  if (task.type === "bulk_delete") {
    return getBulkDeleteResultSummary(task.progress)
  }
  return null
}

function canRetryFailed(task: TaskRow): boolean {
  if (task.status !== "failed") return false
  if (task.type !== "object_transfer") return false
  if (!task.progress || typeof task.progress !== "object") return false
  const failed = toSafeInt((task.progress as { failed?: unknown }).failed)
  return failed > 0
}

function getStatusVariant(status: TaskRow["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default"
  if (status === "failed") return "destructive"
  if (status === "canceled") return "outline"
  if (status === "in_progress") return "secondary"
  return "outline"
}

function isPauseTransition(task: TaskRow): boolean {
  return task.lifecycleState === "paused" && task.status === "in_progress"
}

function isCancelTransition(task: TaskRow): boolean {
  return task.lifecycleState === "canceled" && task.status === "in_progress"
}

function getDisplayState(task: TaskRow): string {
  if (isPauseTransition(task)) return "pausing"
  if (task.lifecycleState === "paused") return "paused"
  if (isCancelTransition(task)) return "canceling"
  if (task.status === "canceled" || task.lifecycleState === "canceled") return "canceled"
  return task.status.replace("_", " ")
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
  const [controllingTaskId, setControllingTaskId] = useState<string | null>(null)
  const [transferPreviewOpen, setTransferPreviewOpen] = useState(false)
  const [transferPreview, setTransferPreview] = useState<TransferTaskPreview | null>(null)
  const [transferConfirmOpen, setTransferConfirmOpen] = useState(false)
  const [pendingTransferBody, setPendingTransferBody] = useState<TransferTaskCreateBody | null>(null)
  const [loadingMoreTransferPlan, setLoadingMoreTransferPlan] = useState(false)
  const [previewActionFilter, setPreviewActionFilter] = useState<string | null>(null)
  const [expandedTaskResults, setExpandedTaskResults] = useState<string | null>(null)
  const [taskEvents, setTaskEvents] = useState<{
    events: Array<{ id: string; eventType: string; message: string; metadata: unknown; at: string }>
    counts: Record<string, number>
    total: number
    page: number
    totalPages: number
  } | null>(null)
  const [taskEventsFilter, setTaskEventsFilter] = useState<string | null>(null)
  const [loadingTaskEvents, setLoadingTaskEvents] = useState(false)
  const [includeProgressSamples, setIncludeProgressSamples] = useState(false)

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
      const res = await fetch("/api/tasks?scope=all&limit=100")
      if (!res.ok) return { tasks: [] }
      return (await res.json()) as { tasks: TaskRow[] }
    },
    refetchInterval: (query) => {
      const data = query.state.data as { tasks?: TaskRow[] } | undefined
      const hasInProgressTask = (data?.tasks ?? []).some((task) => task.status === "in_progress")
      return hasInProgressTask ? 5_000 : 15_000
    },
    refetchIntervalInBackground: false,
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
  const queueTasks = useMemo(
    () =>
      (tasksData?.tasks ?? []).filter(
        (task) =>
          task.lifecycleState !== "canceled" &&
          (
            task.lifecycleState === "paused" ||
            task.status === "pending" ||
            task.status === "in_progress"
          )
      ),
    [tasksData?.tasks]
  )
  const historyTasks = useMemo(
    () =>
      (tasksData?.tasks ?? []).filter(
        (task) =>
          task.status === "completed" ||
          task.status === "failed" ||
          task.status === "canceled" ||
          task.lifecycleState === "canceled"
      ),
    [tasksData?.tasks]
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

  async function fetchTransferPreview(
    body: TransferTaskCreateBody,
    options?: {
      cursor?: TransferTaskDetailedPreviewCursor | null
      limit?: number
    }
  ): Promise<TransferTaskPreview> {
    const res = await fetch("/api/tasks/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        previewOnly: true,
        previewCursor: options?.cursor ?? undefined,
        previewLimit: options?.limit ?? undefined,
      }),
    })

    const data = await res.json()
    if (!res.ok) {
      if (res.status === 403 && data?.details?.plan) {
        throw new Error(
          `${data.error} (resolved plan: ${data.details.plan}, source: ${data.details.planSource})`
        )
      }
      throw new Error(data?.error ?? "Failed to build transfer plan")
    }

    const preview = data?.preview as TransferTaskPreview | undefined
    if (
      !preview ||
      !Array.isArray(preview.summary) ||
      !Array.isArray(preview.commands) ||
      !preview.detailedPlan ||
      !Array.isArray(preview.detailedPlan.actions)
    ) {
      throw new Error("Invalid transfer preview response")
    }

    return preview
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
      toast.success(data?.duplicate ? "Equivalent task already queued" : "Task created")
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

    setSubmitting(true)
    try {
      const preview = await fetchTransferPreview(body)
      setTransferPreview(preview)
      setPendingTransferBody(body)
      setTransferPreviewOpen(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to build transfer plan")
    } finally {
      setSubmitting(false)
    }
  }

  async function handleLoadMoreTransferPlan() {
    if (!pendingTransferBody || !transferPreview?.detailedPlan.hasMore) {
      return
    }
    if (!transferPreview.detailedPlan.nextCursor) {
      return
    }

    setLoadingMoreTransferPlan(true)
    try {
      const nextPreview = await fetchTransferPreview(pendingTransferBody, {
        cursor: transferPreview.detailedPlan.nextCursor,
        limit: transferPreview.detailedPlan.pageSize,
      })

      setTransferPreview((current) => {
        if (!current) return nextPreview

        const mergedCounts = { ...current.detailedPlan.actionCounts }
        for (const key of Object.keys(nextPreview.detailedPlan.actionCounts) as Array<keyof TransferTaskDetailedPreviewActionCounts>) {
          mergedCounts[key] = (mergedCounts[key] ?? 0) + (nextPreview.detailedPlan.actionCounts[key] ?? 0)
        }

        return {
          ...current,
          summary: nextPreview.summary,
          commands: nextPreview.commands,
          estimatedObjects: nextPreview.estimatedObjects,
          sampleObjects:
            current.sampleObjects.length > 0
              ? current.sampleObjects
              : nextPreview.sampleObjects,
          warnings: nextPreview.warnings,
          detailedPlan: {
            ...nextPreview.detailedPlan,
            actions: [...current.detailedPlan.actions, ...nextPreview.detailedPlan.actions],
            actionCounts: mergedCounts,
            totalCounts: current.detailedPlan.totalCounts,
          },
        }
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load more plan actions")
    } finally {
      setLoadingMoreTransferPlan(false)
    }
  }

  async function handleConfirmTransferFromPreview() {
    if (!pendingTransferBody) {
      toast.error("Missing transfer payload")
      return
    }

    if (destructiveTask && !hasDestructiveConfirmBypass(DESTRUCTIVE_CONFIRM_SCOPE)) {
      setTransferPreviewOpen(false)
      setTransferConfirmOpen(true)
      return
    }

    try {
      await createTransferTask(pendingTransferBody)
      setTransferPreviewOpen(false)
      setTransferPreview(null)
      setPendingTransferBody(null)
    } catch {
      // createTransferTask already handled toast
    }
  }

  async function handleTaskControl(
    taskId: string,
    action: "pause" | "resume" | "restart" | "retry_failed" | "cancel"
  ) {
    setControllingTaskId(taskId)
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to control task")
      }
      queryClient.invalidateQueries({ queryKey: ["background-tasks"] })
      queryClient.invalidateQueries({ queryKey: ["background-tasks", "tasks-page"] })
      void refetchTasks()
      toast.success(
        action === "pause"
          ? "Task paused"
          : action === "resume"
            ? "Task resumed"
            : action === "cancel"
              ? "Task canceled"
              : action === "retry_failed"
                ? "Retry for failed items started"
                : "Task restarted"
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to control task")
    } finally {
      setControllingTaskId(null)
    }
  }

  async function handleDeleteTask(taskId: string) {
    if (!window.confirm("Remove this task from history? This cannot be undone.")) {
      return
    }

    setControllingTaskId(taskId)
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "DELETE",
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to remove task")
      }
      queryClient.invalidateQueries({ queryKey: ["background-tasks"] })
      queryClient.invalidateQueries({ queryKey: ["background-tasks", "tasks-page"] })
      void refetchTasks()
      toast.success("Task removed from history")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove task")
    } finally {
      setControllingTaskId(null)
    }
  }

  async function fetchTaskEvents(
    taskId: string,
    page = 1,
    filter?: string | null,
    includeProgress = false
  ) {
    const params = new URLSearchParams({ page: String(page), limit: "50" })
    if (filter) params.set("filter", filter)
    if (includeProgress) params.set("includeProgress", "true")
    const res = await fetch(`/api/tasks/${taskId}/events?${params}`)
    if (!res.ok) throw new Error("Failed to load events")
    return res.json()
  }

  async function toggleTaskResults(taskId: string) {
    if (expandedTaskResults === taskId) {
      setExpandedTaskResults(null)
      setTaskEvents(null)
      setTaskEventsFilter(null)
      return
    }
    setExpandedTaskResults(taskId)
    setTaskEventsFilter(null)
    setLoadingTaskEvents(true)
    try {
      const data = await fetchTaskEvents(taskId, 1, null, includeProgressSamples)
      setTaskEvents(data)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load task events")
      setExpandedTaskResults(null)
    } finally {
      setLoadingTaskEvents(false)
    }
  }

  async function handleTaskEventsFilter(taskId: string, filter: string | null) {
    setTaskEventsFilter(filter)
    setLoadingTaskEvents(true)
    try {
      const data = await fetchTaskEvents(taskId, 1, filter, includeProgressSamples)
      setTaskEvents(data)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load task events")
    } finally {
      setLoadingTaskEvents(false)
    }
  }

  async function handleTaskEventsPage(taskId: string, page: number) {
    setLoadingTaskEvents(true)
    try {
      const data = await fetchTaskEvents(taskId, page, taskEventsFilter, includeProgressSamples)
      setTaskEvents(data)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load task events")
    } finally {
      setLoadingTaskEvents(false)
    }
  }

  async function handleIncludeProgressSamples(taskId: string, enabled: boolean) {
    setIncludeProgressSamples(enabled)
    if (expandedTaskResults !== taskId) return

    setTaskEventsFilter(null)
    setLoadingTaskEvents(true)
    try {
      const data = await fetchTaskEvents(taskId, 1, null, enabled)
      setTaskEvents(data)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load task events")
    } finally {
      setLoadingTaskEvents(false)
    }
  }

  useEffect(() => {
    if (!expandedTaskResults) return

    const expandedTask = (tasksData?.tasks ?? []).find((task) => task.id === expandedTaskResults)
    if (!expandedTask || expandedTask.status !== "in_progress") return

    const intervalId = window.setInterval(() => {
      void (async () => {
        try {
          const data = await fetchTaskEvents(
            expandedTaskResults,
            taskEvents?.page ?? 1,
            taskEventsFilter,
            includeProgressSamples
          )
          setTaskEvents(data)
        } catch {
          // Ignore transient poll errors in background refresh.
        }
      })()
    }, 5_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [expandedTaskResults, includeProgressSamples, taskEvents?.page, taskEventsFilter, tasksData?.tasks])

  function renderTransferLivePanel(task: TaskRow) {
    if (task.type !== "object_transfer" || task.status !== "in_progress") return null
    const live = parseTransferLiveProgress(task.progress)
    if (!live) return null

    const currentTransferred = live.currentFileTransferredBytes ?? BigInt(0)
    const currentTotal = live.currentFileSizeBytes
    const currentPercent =
      currentTotal && currentTotal > BigInt(0)
        ? Math.min(100, Number((currentTransferred * BigInt(100)) / currentTotal))
        : null
    const overallPercent =
      live.bytesEstimatedTotal && live.bytesEstimatedTotal > BigInt(0) && live.bytesProcessedTotal
        ? Math.min(
          100,
          Number((live.bytesProcessedTotal * BigInt(100)) / live.bytesEstimatedTotal)
        )
        : null

    return (
      <div className="mt-2 rounded-md border bg-background p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="capitalize">
            {formatTransferStage(live.currentFileStage)}
          </Badge>
          <Badge variant="outline">{formatTransferStrategy(live.transferStrategy)}</Badge>
          {live.lastProgressAt ? (
            <span className="text-muted-foreground">
              Updated {new Date(live.lastProgressAt).toLocaleTimeString()}
            </span>
          ) : null}
        </div>

        {live.currentFileKey ? (
          <p className="mt-2 truncate font-mono text-xs text-foreground">{live.currentFileKey}</p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Waiting for next file...</p>
        )}

        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${currentPercent ?? 0}%` }}
          />
        </div>

        <p className="mt-1 text-xs text-muted-foreground">
          Current file: {formatBytes(currentTransferred)}
          {currentTotal ? ` / ${formatBytes(currentTotal)}` : ""}
          {currentPercent !== null ? ` (${currentPercent}%)` : ""}
        </p>

        <p className="mt-1 text-xs text-muted-foreground">
          Throughput:{" "}
          {live.throughputBytesPerSec !== null
            ? `${formatBytes(BigInt(Math.floor(live.throughputBytesPerSec)))}/s`
            : "n/a"}{" "}
          • ETA: {formatEtaSeconds(live.etaSeconds)}
        </p>

        <p className="mt-1 text-xs text-muted-foreground">
          Task bytes: {formatBytes(live.bytesProcessedTotal)}
          {live.bytesEstimatedTotal ? ` / ${formatBytes(live.bytesEstimatedTotal)}` : ""}
          {overallPercent !== null ? ` (${overallPercent}%)` : ""}
        </p>

        {live.fallbackReason ? (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950/40">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 text-xs">
              <p className="font-medium text-amber-800 dark:text-amber-300">
                {live.transferStrategy === "multipart_relay_upload"
                  ? "Server-side copy unavailable — using relay upload (slower)"
                  : "Transfer fallback active"}
              </p>
              <p className="mt-0.5 text-amber-700 dark:text-amber-400">
                {live.transferStrategy === "multipart_relay_upload"
                  ? "Your storage provider does not support server-side copy between these buckets. Files are being downloaded and re-uploaded through the server, which is significantly slower."
                  : live.fallbackReason}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  function renderTaskResultsPanel(taskId: string) {
    if (expandedTaskResults !== taskId) return null
    if (loadingTaskEvents && !taskEvents) {
      return (
        <div className="mt-2 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          Loading file results...
        </div>
      )
    }
    if (!taskEvents) return null

    const totalEvents = taskEvents.total
    const progressByFile = new Map<string, {
      sourceKey: string
      latestAt: string
      latest: ProgressEventView
      sampleCount: number
    }>()
    const nonProgressEvents: typeof taskEvents.events = []

    for (const event of taskEvents.events) {
      if (event.eventType !== "file_progress") {
        nonProgressEvents.push(event)
        continue
      }
      const parsed = parseProgressEventView(event.metadata)
      if (!parsed) continue
      const existing = progressByFile.get(parsed.sourceKey)
      if (existing) {
        existing.sampleCount += 1
        if (new Date(event.at).getTime() >= new Date(existing.latestAt).getTime()) {
          existing.latestAt = event.at
          existing.latest = parsed
        }
      } else {
        progressByFile.set(parsed.sourceKey, {
          sourceKey: parsed.sourceKey,
          latestAt: event.at,
          latest: parsed,
          sampleCount: 1,
        })
      }
    }

    const progressFiles = Array.from(progressByFile.values()).sort(
      (a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime()
    )
    const showProgressFiles = includeProgressSamples && (
      taskEventsFilter === null || taskEventsFilter === "file_progress"
    )
    const progressFileCount =
      includeProgressSamples
        ? (
          typeof taskEvents.counts.file_progress === "number"
            ? taskEvents.counts.file_progress
            : progressByFile.size
        )
        : 0
    const hasVisibleEvents =
      nonProgressEvents.length > 0 || (showProgressFiles && progressFiles.length > 0)

    return (
      <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                taskEventsFilter === null
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-accent"
              }`}
              onClick={() => void handleTaskEventsFilter(taskId, null)}
            >
              All: {totalEvents}
            </button>
            {Object.entries(taskEvents.counts)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([eventType, count]) => {
                const label = eventType.replace("file_", "").replace("batch_", "")
                const isActive = taskEventsFilter === eventType
                const displayCount =
                  eventType === "file_progress" ? progressFileCount : count
                return (
                  <button
                    key={eventType}
                    type="button"
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : eventType === "file_copied" || eventType === "file_moved"
                          ? "border-green-300 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-700 dark:bg-green-950 dark:text-green-300"
                          : eventType === "file_skipped" || eventType === "batch_skipped"
                            ? "border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400"
                            : eventType === "file_progress"
                              ? "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-300"
                              : eventType === "adaptive_fallback"
                                ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
                                : "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-700 dark:bg-red-950 dark:text-red-300"
                    }`}
                    onClick={() => void handleTaskEventsFilter(taskId, isActive ? null : eventType)}
                  >
                    {label}: {displayCount}
                  </button>
                )
              })}
          </div>
          <Button
            variant={includeProgressSamples ? "default" : "outline"}
            size="sm"
            onClick={() => void handleIncludeProgressSamples(taskId, !includeProgressSamples)}
          >
            {includeProgressSamples ? "Hide Live Progress" : "Include Live Progress"}
          </Button>
        </div>

        {showProgressFiles && progressFiles.length > 0 ? (
          <div className="space-y-2 rounded-md border bg-background p-2 font-mono text-xs">
            {progressFiles.map((fileProgress) => {
              const latest = fileProgress.latest
              const percent =
                latest.totalBytes && latest.totalBytes > BigInt(0) && latest.transferredBytes
                  ? Math.min(100, Number((latest.transferredBytes * BigInt(100)) / latest.totalBytes))
                  : null
              const speed =
                latest.throughputBytesPerSec !== null
                  ? `${formatBytes(BigInt(Math.floor(latest.throughputBytesPerSec)))}/s`
                  : "n/a"
              return (
                <div key={fileProgress.sourceKey} className="space-y-1 rounded border p-2">
                  <p className="truncate text-[11px] font-semibold text-foreground">
                    {fileProgress.sourceKey}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {latest.destinationKey} • {latest.stage} • {latest.strategy.replace(/_/g, " ")}
                  </p>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-blue-500 transition-all"
                      style={{ width: `${percent ?? 0}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {formatBytes(latest.transferredBytes)}
                    {latest.totalBytes ? ` / ${formatBytes(latest.totalBytes)}` : ""}
                    {percent !== null ? ` (${percent}%)` : ""} • {speed} • ETA{" "}
                    {formatEtaSeconds(latest.etaSeconds)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Updated {new Date(fileProgress.latestAt).toLocaleTimeString()} • Samples{" "}
                    {fileProgress.sampleCount}
                  </p>
                </div>
              )
            })}
          </div>
        ) : null}

        {showProgressFiles && progressFiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No file progress recorded on this page yet.
          </p>
        ) : null}

        {nonProgressEvents.length > 0 ? (
          <ul className="max-h-72 overflow-y-auto overflow-x-hidden rounded-md border bg-background p-2 font-mono text-xs">
            {nonProgressEvents.map((event) => (
              <li
                key={event.id}
                className={`break-all py-0.5 whitespace-normal ${
                  event.eventType === "file_copied" || event.eventType === "file_moved"
                    ? "text-green-700 dark:text-green-400"
                    : event.eventType === "file_skipped" || event.eventType === "batch_skipped"
                      ? "text-muted-foreground"
                      : event.eventType === "file_failed" || event.eventType === "file_missing_source"
                        ? "text-red-600 dark:text-red-400"
                        : event.eventType === "adaptive_fallback"
                          ? "text-amber-600 dark:text-amber-400"
                          : ""
                }`}
              >
                {event.message}
              </li>
            ))}
          </ul>
        ) : null}

        {nonProgressEvents.length === 0 && (!showProgressFiles || progressFiles.length === 0) ? (
          <p className="text-xs text-muted-foreground">
            {taskEventsFilter || hasVisibleEvents
              ? "No events matching this filter."
              : "No file-level events recorded for this task."}
          </p>
        ) : null}

        {taskEvents.totalPages > 1 ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Button
              variant="outline"
              size="sm"
              disabled={taskEvents.page <= 1 || loadingTaskEvents}
              onClick={() => void handleTaskEventsPage(taskId, taskEvents.page - 1)}
            >
              Previous
            </Button>
            <span>
              Page {taskEvents.page} of {taskEvents.totalPages} ({taskEvents.total} total)
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={taskEvents.page >= taskEvents.totalPages || loadingTaskEvents}
              onClick={() => void handleTaskEventsPage(taskId, taskEvents.page + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>
    )
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
        <CardHeader>
          <div className="space-y-1">
            <CardTitle>Start New Task</CardTitle>
            <CardDescription>
              Transfers run on cached files only and follow plan limits. Sync mirrors destination
              scope and deletes destination-only files.
            </CardDescription>
          </div>
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
                  description="Select the source folder or bucket root from cached paths."
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
                  description="Select the destination folder or bucket root from cached paths."
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
          <CardTitle>Queue</CardTitle>
          <CardDescription>Live tasks with pause/resume/restart/cancel controls.</CardDescription>
        </CardHeader>
        <CardContent>
          {queueTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No queued tasks.</p>
          ) : (
            <div className="space-y-2">
              {queueTasks.map((task) => (
                <div key={task.id} className="rounded-md border px-3 py-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="min-w-0 text-sm font-medium leading-5">{task.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Updated {new Date(task.updatedAt).toLocaleString()} • Runs {task.runCount}
                      </p>
                      {(task.successRuns > 0 || task.failedRuns > 0) ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Run summary: {task.successRuns} succeeded • {task.failedRuns} failed
                        </p>
                      ) : null}
                      {getTaskResultSummary(task) ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Latest result: {getTaskResultSummary(task)}
                        </p>
                      ) : null}
                      {task.lastError ? (
                        <p className="mt-1 text-xs text-destructive">{task.lastError}</p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          task.lifecycleState !== "active"
                            ? "outline"
                            : getStatusVariant(task.status)
                        }
                        className="h-6 px-2 text-xs capitalize"
                      >
                        {getDisplayState(task)}
                      </Badge>
                      {task.lifecycleState === "paused" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={controllingTaskId === task.id || isPauseTransition(task)}
                          onClick={() => void handleTaskControl(task.id, "resume")}
                        >
                          <Play className="mr-1 h-3.5 w-3.5" />
                          Resume
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            controllingTaskId === task.id ||
                            task.status === "completed" ||
                            task.status === "canceled"
                          }
                          onClick={() => void handleTaskControl(task.id, "pause")}
                        >
                          <Pause className="mr-1 h-3.5 w-3.5" />
                          Pause
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={controllingTaskId === task.id || task.status === "in_progress"}
                        onClick={() => void handleTaskControl(task.id, "restart")}
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                        Restart
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={controllingTaskId === task.id || isPauseTransition(task)}
                        onClick={() => void handleTaskControl(task.id, "cancel")}
                      >
                        Cancel Task
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void toggleTaskResults(task.id)}
                      >
                        {expandedTaskResults === task.id ? "Hide Results" : "View Results"}
                      </Button>
                    </div>
                  </div>
                  {renderTransferLivePanel(task)}
                  {renderTaskResultsPanel(task.id)}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            Completed, failed, and canceled tasks, with latest execution note and cleanup controls.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {historyTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No task history yet.</p>
          ) : (
            <div className="space-y-2">
              {historyTasks.map((task) => (
                <div key={task.id} className="rounded-md border px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="min-w-0 text-sm font-medium leading-5">{task.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Created {new Date(task.createdAt).toLocaleString()}
                        {task.completedAt
                          ? ` • Completed ${new Date(task.completedAt).toLocaleString()}`
                          : ""}
                      </p>
                      {(task.successRuns > 0 || task.failedRuns > 0) ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Run summary: {task.successRuns} succeeded • {task.failedRuns} failed
                        </p>
                      ) : null}
                      {getTaskResultSummary(task) ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Latest result: {getTaskResultSummary(task)}
                        </p>
                      ) : null}
                      {task.executionHistory[0]?.message ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Last event: {task.executionHistory[0].message}
                        </p>
                      ) : null}
                      {task.lastError ? (
                        <p className="mt-1 text-xs text-destructive">{task.lastError}</p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={task.lifecycleState !== "active" ? "outline" : getStatusVariant(task.status)}
                        className="h-6 px-2 text-xs capitalize"
                      >
                        {getDisplayState(task)}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={controllingTaskId === task.id || task.status === "in_progress"}
                        onClick={() => void handleTaskControl(task.id, "restart")}
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                        Restart
                      </Button>
                      {canRetryFailed(task) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={controllingTaskId === task.id}
                          onClick={() => void handleTaskControl(task.id, "retry_failed")}
                        >
                          Retry Failed
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={controllingTaskId === task.id || task.status === "in_progress"}
                        onClick={() => void handleDeleteTask(task.id)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Remove
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void toggleTaskResults(task.id)}
                      >
                        {expandedTaskResults === task.id ? "Hide Results" : "View Results"}
                      </Button>
                    </div>
                  </div>
                  {renderTaskResultsPanel(task.id)}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={transferPreviewOpen}
        onOpenChange={(open) => {
          setTransferPreviewOpen(open)
          if (!open) {
            setTransferPreview(null)
            setLoadingMoreTransferPlan(false)
            setPreviewActionFilter(null)
            if (!transferConfirmOpen) {
              setPendingTransferBody(null)
            }
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Task Execution Plan</DialogTitle>
            <DialogDescription>
              Review the planned execution summary before this task starts.
            </DialogDescription>
          </DialogHeader>

          {transferPreview ? (
            <div className="space-y-4 text-sm">
              <div className="space-y-2">
                <p className="font-medium">Summary</p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {transferPreview.summary.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>

              <div className="space-y-2">
                <p className="font-medium">Planned commands</p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {transferPreview.commands.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>

              <div className="space-y-2">
                {(() => {
                  const displayCounts = transferPreview.detailedPlan.totalCounts ?? transferPreview.detailedPlan.actionCounts
                  const totalAll = Object.values(displayCounts).reduce((a, b) => a + b, 0)
                  const hasTotalCounts = Boolean(transferPreview.detailedPlan.totalCounts)
                  return (
                    <>
                      <p className="font-medium">
                        Planned object actions
                        {hasTotalCounts
                          ? ` (${totalAll.toLocaleString()} total, ${transferPreview.detailedPlan.actions.length} loaded)`
                          : ` (${transferPreview.detailedPlan.actions.length} loaded)`}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                            previewActionFilter === null
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background text-muted-foreground hover:bg-accent"
                          }`}
                          onClick={() => setPreviewActionFilter(null)}
                        >
                          All: {totalAll.toLocaleString()}
                        </button>
                        {(Object.entries(displayCounts) as Array<[string, number]>)
                          .filter(([, count]) => count > 0)
                    .map(([op, count]) => (
                      <button
                        key={op}
                        type="button"
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                          previewActionFilter === op
                            ? "border-primary bg-primary text-primary-foreground"
                            : op === "copy"
                              ? "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-300"
                              : op === "skip"
                                ? "border-gray-300 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400"
                                : "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-700 dark:bg-red-950 dark:text-red-300"
                        }`}
                        onClick={() => setPreviewActionFilter(previewActionFilter === op ? null : op)}
                      >
                        {op.replace("_", " ")}: {count.toLocaleString()}
                      </button>
                    ))}
                      </div>
                    </>
                  )
                })()}
                {(() => {
                  const filteredActions = previewActionFilter
                    ? transferPreview.detailedPlan.actions.filter((a) => a.operation === previewActionFilter)
                    : transferPreview.detailedPlan.actions
                  return filteredActions.length > 0 ? (
                    <ul className="max-h-72 overflow-y-auto overflow-x-hidden rounded-md border p-2 font-mono text-xs">
                      {filteredActions.map((action, index) => (
                        <li
                          key={`${action.command}:${action.sourceKey ?? "none"}:${action.destinationKey ?? "none"}:${index}`}
                          className={`break-all py-0.5 whitespace-normal ${
                            action.operation === "skip"
                              ? "text-muted-foreground"
                              : action.operation === "copy"
                                ? "text-blue-700 dark:text-blue-400"
                                : action.operation === "delete_source" || action.operation === "delete_destination"
                                  ? "text-red-600 dark:text-red-400"
                                  : ""
                          }`}
                        >
                          {action.command}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {previewActionFilter
                        ? `No ${previewActionFilter.replace("_", " ")} actions found.`
                        : "No object-level actions in this page. Load more to continue scanning."}
                    </p>
                  )
                })()}
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    Scanned {transferPreview.detailedPlan.scannedSourceObjects.toLocaleString()} source objects in this
                    request.
                  </span>
                  {transferPreview.detailedPlan.scanLimitReached ? (
                    <span>Scan limit reached for this page; load more to continue.</span>
                  ) : null}
                </div>
                {transferPreview.detailedPlan.hasMore ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleLoadMoreTransferPlan()}
                    disabled={loadingMoreTransferPlan || submitting}
                  >
                    {loadingMoreTransferPlan ? "Loading..." : "Load more actions"}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Full plan loaded for the current cached metadata snapshot.
                  </p>
                )}
              </div>

              {transferPreview.warnings.length > 0 ? (
                <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <p className="font-medium text-destructive">Warnings</p>
                  <ul className="list-disc space-y-1 pl-5 text-xs text-destructive">
                    {transferPreview.warnings.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setTransferPreviewOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleConfirmTransferFromPreview()} disabled={submitting}>
              {submitting ? "Starting..." : "Start Task"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog
        open={transferConfirmOpen}
        onOpenChange={(open) => {
          setTransferConfirmOpen(open)
          if (!open) {
            setTransferPreview(null)
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
          setTransferPreview(null)
          setPendingTransferBody(null)
        }}
      />
    </div>
  )
}
