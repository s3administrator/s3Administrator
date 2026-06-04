import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

export function useRefreshBucketQueries() {
  const queryClient = useQueryClient()

  const refreshBucketQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["buckets"] }),
      queryClient.invalidateQueries({ queryKey: ["bucket-stats"] }),
      queryClient.invalidateQueries({ queryKey: ["bucket-settings"] }),
      queryClient.invalidateQueries({ queryKey: ["objects"] }),
    ])
  }, [queryClient])

  return refreshBucketQueries
}
