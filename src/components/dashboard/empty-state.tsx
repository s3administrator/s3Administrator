import Link from "next/link"
import { FolderOpen, HardDrive, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"

interface EmptyStateProps {
  type: "no-files" | "no-buckets" | "no-credentials"
}

type EmptyStateConfigItem = {
  icon: typeof FolderOpen
  title: string
  description: string
  actionLabel?: string
  actionHref?: string
}

const CONFIG: Record<EmptyStateProps["type"], EmptyStateConfigItem> = {
  "no-files": {
    icon: FolderOpen,
    title: "No files here",
    description:
      "This folder is empty. Upload files or create a new folder to get started.",
  },
  "no-buckets": {
    icon: HardDrive,
    title: "No buckets found",
    description:
      "No S3 buckets were found for the current credentials. Create a bucket in your provider's console or check your credentials in Settings.",
  },
  "no-credentials": {
    icon: KeyRound,
    title: "No credentials configured",
    description:
      "Add your S3 credentials in Settings to start managing your storage.",
    actionLabel: "Add Credentials",
    actionHref: "/settings",
  },
}

export function EmptyState({ type }: EmptyStateProps) {
  const { icon: Icon, title, description, actionLabel, actionHref } = CONFIG[type]

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 rounded-full bg-muted p-4">
        <Icon className="h-10 w-10 text-muted-foreground" />
      </div>
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {actionLabel && actionHref ? (
        <Button asChild variant="outline" className="mt-4">
          <Link href={actionHref}>{actionLabel}</Link>
        </Button>
      ) : null}
    </div>
  )
}
