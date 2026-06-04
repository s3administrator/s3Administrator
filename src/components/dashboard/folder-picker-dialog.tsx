"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, Folder, FolderOpen, Home, ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { S3Object } from "@/types"

interface FolderPickerDialogProps {
  credentialId: string
  bucket: string
  value: string
  onChange: (prefix: string) => void
  title: string
  description?: string
  disabled?: boolean
}

function folderNameFromKey(key: string, parentPrefix: string): string {
  const relative = key.startsWith(parentPrefix) ? key.slice(parentPrefix.length) : key
  return relative.replace(/\/$/, "")
}

function getParentPrefix(prefix: string): string {
  if (!prefix) return ""
  const parts = prefix.replace(/\/$/, "").split("/").filter(Boolean)
  parts.pop()
  return parts.length > 0 ? `${parts.join("/")}/` : ""
}

function buildSegments(prefix: string): Array<{ label: string; value: string }> {
  if (!prefix) return []
  const parts = prefix.replace(/\/$/, "").split("/").filter(Boolean)
  const segments: Array<{ label: string; value: string }> = []
  let current = ""
  for (const part of parts) {
    current += `${part}/`
    segments.push({ label: part, value: current })
  }
  return segments
}

export function FolderPickerDialog({
  credentialId,
  bucket,
  value,
  onChange,
  title,
  description,
  disabled = false,
}: FolderPickerDialogProps) {
  const [open, setOpen] = useState(false)
  const [currentPrefix, setCurrentPrefix] = useState(value)

  const canBrowse = Boolean(credentialId && bucket) && !disabled

  const { data, isLoading, isFetching } = useQuery<{ folders: S3Object[]; files: S3Object[] }>({
    queryKey: ["folder-picker", credentialId, bucket, currentPrefix],
    enabled: open && canBrowse,
    queryFn: async () => {
      const params = new URLSearchParams({ bucket })
      if (credentialId) params.set("credentialId", credentialId)
      if (currentPrefix) params.set("prefix", currentPrefix)
      const res = await fetch(`/api/s3/objects?${params}`)
      if (!res.ok) {
        throw new Error("Failed to list folders")
      }
      return (await res.json()) as { folders: S3Object[]; files: S3Object[] }
    },
  })

  const folders = useMemo(() => data?.folders ?? [], [data?.folders])
  const segments = useMemo(() => buildSegments(currentPrefix), [currentPrefix])

  function handleSelectCurrent() {
    onChange(currentPrefix)
    setOpen(false)
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full justify-start"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <Folder className="mr-2 h-4 w-4" />
        {value ? value : "Bucket root"}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (nextOpen) {
            setCurrentPrefix(value)
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {description ?? "Browse folders and select one."}
            </DialogDescription>
          </DialogHeader>

          {!canBrowse ? (
            <p className="text-sm text-muted-foreground">
              Select account and bucket first.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted"
                  onClick={() => setCurrentPrefix("")}
                >
                  <Home className="h-3.5 w-3.5" />
                  Root
                </button>
                {segments.map((segment) => (
                  <span key={segment.value} className="inline-flex items-center gap-1">
                    <ChevronRight className="h-3.5 w-3.5" />
                    <button
                      type="button"
                      className="rounded px-1 py-0.5 hover:bg-muted"
                      onClick={() => setCurrentPrefix(segment.value)}
                    >
                      {segment.label}
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPrefix(getParentPrefix(currentPrefix))}
                  disabled={!currentPrefix}
                >
                  <ArrowUp className="mr-1.5 h-3.5 w-3.5" />
                  Up
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSelectCurrent}
                >
                  {currentPrefix ? "Select Current Folder" : "Select Bucket Root"}
                </Button>
              </div>

              <div className="max-h-72 overflow-auto rounded-md border">
                {isLoading || isFetching ? (
                  <div className="p-3 text-sm text-muted-foreground">Loading folders...</div>
                ) : folders.length === 0 ? (
                  <div className="p-3 text-sm text-muted-foreground">
                    No subfolders in this location.
                  </div>
                ) : (
                  <div className="divide-y">
                    {folders.map((folder) => (
                      <div key={folder.key} className="flex items-center justify-between p-2">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
                          onClick={() => setCurrentPrefix(folder.key)}
                        >
                          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm">
                            {folderNameFromKey(folder.key, currentPrefix)}
                          </span>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            onChange(folder.key)
                            setOpen(false)
                          }}
                        >
                          Select
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
