import { useState } from "react"
import { toast } from "sonner"
import { useRefreshBucketQueries } from "@/hooks/use-refresh-bucket-queries"

export function useDeleteBucket() {
  const [isDeleting, setIsDeleting] = useState(false)
  const refreshBucketQueries = useRefreshBucketQueries()

  async function deleteBucket(bucket: string, credentialId: string) {
    setIsDeleting(true)
    try {
      const res = await fetch("/api/s3/buckets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket, credentialId }),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(payload?.error ?? "Failed to delete bucket")
      }

      toast.success("Bucket deleted")
      await refreshBucketQueries()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete bucket")
      throw error
    } finally {
      setIsDeleting(false)
    }
  }

  return { deleteBucket, isDeleting }
}
