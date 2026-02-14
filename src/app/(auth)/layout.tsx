import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { isCommunityEdition } from "@/lib/edition"

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (isCommunityEdition()) {
    redirect("/dashboard")
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-muted/30">
      <div className="absolute right-4 top-4">
        <ThemeSwitcher />
      </div>
      <div className="w-full max-w-md px-4">{children}</div>
    </div>
  )
}
