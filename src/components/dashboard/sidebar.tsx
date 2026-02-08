"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { signOut } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Database,
  Settings,
  CreditCard,
  LogOut,
  HardDrive,
} from "lucide-react"
import { cn } from "@/lib/utils"

export function Sidebar() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const { data: buckets, isLoading } = useQuery<{ name: string }[]>({
    queryKey: ["buckets"],
    queryFn: async () => {
      const res = await fetch("/api/s3/buckets")
      if (!res.ok) return []
      const data = await res.json()
      return data.buckets ?? []
    },
  })

  return (
    <div className="flex h-full w-56 flex-col border-r bg-muted/30">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5" />
          <span>S3 Manager</span>
        </Link>
      </div>

      <ScrollArea className="flex-1 px-3 py-3">
        <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">
          Buckets
        </p>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : buckets && buckets.length > 0 ? (
          <div className="space-y-1">
            {buckets.map((bucket) => {
              const href = `/dashboard?bucket=${encodeURIComponent(bucket.name)}`
              const isActive =
                pathname === "/dashboard" &&
                searchParams.get("bucket") === bucket.name
              return (
                <Link
                  key={bucket.name}
                  href={href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                    isActive && "bg-accent"
                  )}
                >
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{bucket.name}</span>
                </Link>
              )
            })}
          </div>
        ) : (
          <p className="px-2 text-sm text-muted-foreground">
            No buckets found. Add your S3 credentials in Settings.
          </p>
        )}
      </ScrollArea>

      <Separator />
      <div className="space-y-1 p-3">
        <Link
          href="/settings"
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
            pathname === "/settings" && "bg-accent"
          )}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
        <Link
          href="/billing"
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
            pathname === "/billing" && "bg-accent"
          )}
        >
          <CreditCard className="h-4 w-4" />
          Billing
        </Link>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 px-2"
          onClick={() => signOut({ callbackUrl: "/" })}
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </Button>
      </div>
    </div>
  )
}
