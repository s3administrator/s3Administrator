"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Shield,
  Users,
  BarChart3,
  LogOut,
  ArrowLeft,
  Package,
  CreditCard,
  Activity,
} from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { href: "/admin", label: "Overview", icon: BarChart3 },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/plans", label: "Plans", icon: Package },
  { href: "/admin/subscriptions", label: "Subscriptions", icon: CreditCard },
  { href: "/admin/actions", label: "Actions", icon: Activity },
]

export function AdminSidebar() {
  const pathname = usePathname()

  return (
    <div className="flex h-full w-56 flex-col border-r bg-muted/30">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/admin" className="flex items-center gap-2 font-semibold">
          <Shield className="h-5 w-5" />
          <span>Admin</span>
        </Link>
      </div>

      <div className="flex-1 space-y-1 p-3">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
              pathname === href && "bg-accent"
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </div>

      <Separator />
      <div className="space-y-1 p-3">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to App
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
