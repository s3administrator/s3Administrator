"use client"

import { useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { Suspense, useEffect, useState } from "react"
import { Sidebar } from "@/components/dashboard/sidebar"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Loader2, PanelLeft } from "lucide-react"

const isCommunity = (process.env.NEXT_PUBLIC_EDITION || "").trim().toLowerCase() !== "cloud"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { status } = useSession()
  const router = useRouter()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!isCommunity && status === "unauthenticated") {
      router.push("/login")
    }
  }, [status, router])

  // In cloud mode, show loading state until client is mounted and session is resolved.
  // This prevents hydration mismatches between server (no session) and client.
  if (!isCommunity && (!mounted || status === "loading")) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isCommunity && status === "unauthenticated") {
    return null
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden md:block">
        <Suspense>
          <Sidebar />
        </Suspense>
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
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">
                Sidebar navigation and background task shortcuts.
              </SheetDescription>
              <Suspense>
                <Sidebar className="w-full border-r-0 lg:w-full" collapsible={false} />
              </Suspense>
            </SheetContent>
          </Sheet>
          <p className="ml-2 text-sm font-semibold">S3 Administrator</p>
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
