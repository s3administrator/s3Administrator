"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Database,
  Users,
  BarChart3,
  LogOut,
  ArrowLeft,
  Package,
  CreditCard,
  Activity,
  ScrollText,
  Server,
  FileText,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ThemeSwitcher } from "@/components/theme-switcher"

const navItems = [
  { href: "/admin", label: "Overview", icon: BarChart3 },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/plans", label: "Plans", icon: Package },
  { href: "/admin/subscriptions", label: "Subscriptions", icon: CreditCard },
  { href: "/admin/transactions", label: "Transactions", icon: FileText },
  { href: "/admin/actions", label: "Actions", icon: Activity },
  { href: "/admin/logs", label: "System Logs", icon: ScrollText },
  { href: "/admin/server", label: "Server Metrics", icon: Server },
]

export function AdminSidebar({
  className,
  onNavigate,
  collapsible = true,
}: {
  className?: string
  onNavigate?: () => void
  collapsible?: boolean
}) {
  const pathname = usePathname()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const sidebarCollapsed = collapsible && isCollapsed

  return (
    <div
      className={cn(
        "relative z-50 flex h-full min-h-0 shrink-0 flex-col border-r bg-muted/30 transition-[width] duration-200",
        sidebarCollapsed ? "w-20 lg:w-20" : "w-80 lg:w-96",
        className
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b",
          sidebarCollapsed ? "justify-between px-2" : "justify-between px-4"
        )}
      >
        <Link
          href="/admin"
          className={cn(
            "flex items-center font-semibold",
            sidebarCollapsed ? "justify-center px-1" : "gap-2"
          )}
          onClick={onNavigate}
        >
          <Database className="h-5 w-5" />
          {!sidebarCollapsed && <span>S3 Administrator</span>}
        </Link>
        {sidebarCollapsed ? (
          collapsible && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setIsCollapsed(false)}
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          )
        ) : (
          <div className="flex items-center gap-1">
            <ThemeSwitcher />
            {collapsible && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setIsCollapsed(true)}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
              >
                <ChevronsLeft className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 space-y-1 overflow-y-auto [-webkit-overflow-scrolling:touch]",
          sidebarCollapsed ? "p-2" : "p-3"
        )}
      >
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            title={label}
            className={cn(
              "flex rounded-md hover:bg-accent",
              sidebarCollapsed
                ? "justify-center px-2 py-2"
                : "items-center gap-2 px-2 py-1.5 text-sm",
              pathname === href && "bg-accent"
            )}
          >
            <Icon className="h-4 w-4" />
            {!sidebarCollapsed && label}
          </Link>
        ))}
      </div>

      <Separator />
      <div className={cn("space-y-1", sidebarCollapsed ? "p-2" : "p-3")}>
        {sidebarCollapsed && (
          <div className="flex justify-center pb-1">
            <ThemeSwitcher />
          </div>
        )}
        <Link
          href="/dashboard"
          onClick={onNavigate}
          title="Back to App"
          className={cn(
            "flex rounded-md hover:bg-accent",
            sidebarCollapsed
              ? "justify-center px-2 py-2"
              : "items-center gap-2 px-2 py-1.5 text-sm"
          )}
        >
          <ArrowLeft className="h-4 w-4" />
          {!sidebarCollapsed && "Back to App"}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          title="Sign Out"
          className={cn(
            "w-full px-2",
            sidebarCollapsed
              ? "h-8 justify-center"
              : "justify-start gap-2"
          )}
          onClick={() => {
            onNavigate?.()
            void signOut({ callbackUrl: "/" })
          }}
        >
          <LogOut className="h-4 w-4" />
          {!sidebarCollapsed && "Sign Out"}
        </Button>
      </div>
    </div>
  )
}
