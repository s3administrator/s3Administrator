"use client"

import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Users, Database, Files } from "lucide-react"

interface Stats {
  totalUsers: number
  totalCredentials: number
  totalFiles: number
  tierBreakdown: Record<string, number>
}

export default function AdminPage() {
  const { data: stats, isLoading } = useQuery<Stats>({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const res = await fetch("/api/admin/stats")
      if (!res.ok) throw new Error("Failed to load stats")
      return res.json()
    },
  })

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-muted-foreground">System statistics</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {isLoading ? (
          <>
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Users className="h-4 w-4" /> Total Users
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{stats?.totalUsers ?? 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Database className="h-4 w-4" /> S3 Credentials
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">
                  {stats?.totalCredentials ?? 0}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Files className="h-4 w-4" /> Cached Files
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{stats?.totalFiles ?? 0}</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {stats?.tierBreakdown && (
        <div className="mt-6">
          <h2 className="mb-3 text-lg font-semibold">Subscription Breakdown</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {["free", "pro", "team"].map((tier) => (
              <Card key={tier}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium capitalize text-muted-foreground">
                    {tier}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-3xl font-bold">
                    {stats.tierBreakdown[tier] ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground">users</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
