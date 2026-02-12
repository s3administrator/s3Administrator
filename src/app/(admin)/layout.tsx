"use client"

import { useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { AdminSidebar } from "@/components/admin/sidebar"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Loader2, PanelLeft } from "lucide-react"

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login")
    } else if (status === "authenticated" && session?.user?.role !== "admin") {
      router.push("/dashboard")
    }
  }, [status, session, router])

  if (status === "loading") {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (status === "unauthenticated" || session?.user?.role !== "admin") {
    return null
  }

  return (
    <div className="flex h-dvh min-h-screen overflow-hidden">
      <aside className="hidden md:block">
        <AdminSidebar />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 items-center border-b bg-background/95 px-2.5 md:hidden">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <PanelLeft className="h-4 w-4" />
                <span className="sr-only">Open navigation</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="z-[90] w-[84vw] max-w-[320px] border-r p-0"
            >
              <SheetTitle className="sr-only">Admin navigation</SheetTitle>
              <SheetDescription className="sr-only">
                Navigate through admin pages.
              </SheetDescription>
              <AdminSidebar
                className="w-full border-r-0"
                onNavigate={() => setMobileNavOpen(false)}
                collapsible={false}
              />
            </SheetContent>
          </Sheet>
          <p className="ml-2 text-sm font-semibold">Admin Panel</p>
        </header>
        <main className="flex-1 overflow-y-auto overflow-x-hidden [-webkit-overflow-scrolling:touch]">
          {children}
        </main>
      </div>
    </div>
  )
}
