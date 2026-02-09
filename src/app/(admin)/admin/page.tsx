"use client"

import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Users, Database, Files, Activity, AlertTriangle } from "lucide-react"

interface Stats {
  totalUsers: number
  totalCredentials: number
  totalFiles: number
  totalEvents: number
  tierBreakdown: Record<string, number>
  actionMetrics: {
    eventsLast24h: number
    eventsLast7d: number
    activeUsersLast24h: number
    activeUsersLast7d: number
    signInsLast7d: number
    apiCallsLast24h: number
    apiErrorsLast24h: number
    apiErrorRateLast24h: number
  }
  topEventTypesLast7d: Array<{ label: string; count: number }>
  topPathsLast7d: Array<{ label: string; count: number }>
  dailyEventsLast14d: Array<{ date: string; count: number }>
}

function formatPercent(value: number) {
  return `${value.toFixed(2)}%`
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
        <p className="text-sm text-muted-foreground">
          Key metrics for usage, activity, and reliability
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading ? (
          <>
            <Skeleton className="h-28" />
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
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Activity className="h-4 w-4" /> Total Actions Logged
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{stats?.totalEvents ?? 0}</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading ? (
          <>
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Events (24h)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {stats?.actionMetrics.eventsLast24h ?? 0}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Events (7d)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {stats?.actionMetrics.eventsLast7d ?? 0}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Active Users (24h)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {stats?.actionMetrics.activeUsersLast24h ?? 0}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Sign-ins (7d)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {stats?.actionMetrics.signInsLast7d ?? 0}
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
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
                  <AlertTriangle className="h-4 w-4" /> API Error Rate (24h)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {formatPercent(stats?.actionMetrics.apiErrorRateLast24h ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {stats?.actionMetrics.apiErrorsLast24h ?? 0} errors /{" "}
                  {stats?.actionMetrics.apiCallsLast24h ?? 0} calls
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  API Calls (24h)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {stats?.actionMetrics.apiCallsLast24h ?? 0}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Active Users (7d)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {stats?.actionMetrics.activeUsersLast7d ?? 0}
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {stats?.tierBreakdown && (
        <div className="mt-6">
          <h2 className="mb-3 text-lg font-semibold">Subscription Breakdown</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {["free", "starter", "pro", "enterprise"].map((tier) => (
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

      {!isLoading && stats && (
        <div className="mt-6 grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Activity Trend (Last 14 Days)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex h-40 items-end gap-1">
                {stats.dailyEventsLast14d.map((point) => {
                  const max = Math.max(
                    1,
                    ...stats.dailyEventsLast14d.map((d) => d.count)
                  )
                  const height = Math.max(4, (point.count / max) * 120)
                  return (
                    <div key={point.date} className="flex flex-1 flex-col items-center gap-1">
                      <div
                        className="w-full rounded-sm bg-primary/70"
                        style={{ height }}
                        title={`${point.date}: ${point.count}`}
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {point.date.slice(5)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Top Event Types (7d)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {stats.topEventTypesLast7d.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data yet.</p>
              ) : (
                stats.topEventTypesLast7d.map((item) => {
                  const max = Math.max(
                    1,
                    ...stats.topEventTypesLast7d.map((d) => d.count)
                  )
                  return (
                    <div key={item.label} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="truncate pr-2 font-medium">{item.label}</span>
                        <span className="text-muted-foreground">{item.count}</span>
                      </div>
                      <div className="h-2 rounded bg-muted">
                        <div
                          className="h-2 rounded bg-primary"
                          style={{ width: `${(item.count / max) * 100}%` }}
                        />
                      </div>
                    </div>
                  )
                })
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {!isLoading && stats && (
        <div className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Top Paths (7d)
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {stats.topPathsLast7d.length === 0 ? (
                <p className="text-sm text-muted-foreground">No data yet.</p>
              ) : (
                stats.topPathsLast7d.map((item) => {
                  const max = Math.max(1, ...stats.topPathsLast7d.map((d) => d.count))
                  return (
                    <div key={item.label} className="space-y-1 rounded border p-2">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="max-w-[80%] truncate font-mono">{item.label}</span>
                        <span className="text-muted-foreground">{item.count}</span>
                      </div>
                      <div className="h-2 rounded bg-muted">
                        <div
                          className="h-2 rounded bg-primary/80"
                          style={{ width: `${(item.count / max) * 100}%` }}
                        />
                      </div>
                    </div>
                  )
                })
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
