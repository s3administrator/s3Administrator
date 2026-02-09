import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Suspense } from "react"
import { Toaster } from "@/components/ui/sonner"
import { QueryProvider } from "@/components/providers/query-provider"
import { SessionProvider } from "@/components/providers/session-provider"
import { ThemeProvider } from "@/components/providers/theme-provider"
import { GoogleAnalytics } from "@/components/providers/google-analytics"
import { ActionTracker } from "@/components/providers/action-tracker"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "S3 Admin",
  description: "Manage your S3 storage across any provider with ease",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const gaMeasurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
  const actionTrackingEnabled = process.env.ENABLE_ACTION_TRACKING !== "false"

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Suspense fallback={null}>
          <GoogleAnalytics measurementId={gaMeasurementId} />
        </Suspense>
        <ThemeProvider>
          <SessionProvider>
            <QueryProvider>
              <Suspense fallback={null}>
                <ActionTracker enabled={actionTrackingEnabled} />
              </Suspense>
              {children}
              <Toaster />
            </QueryProvider>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
