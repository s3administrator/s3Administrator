import { auth } from "@/lib/auth"
import { NextResponse } from "next/server"
import { logSystemEvent } from "@/lib/system-logger"

const LOG_API_REQUESTS =
  (process.env.SYSTEM_LOG_API_REQUESTS ?? "true").toLowerCase() !== "false"

function shouldLogApiRequest(pathname: string) {
  if (!LOG_API_REQUESTS) return false
  if (!pathname.startsWith("/api/")) return false

  // Avoid writing a log entry for each log fetch request.
  if (pathname === "/api/admin/logs") return false

  return true
}

export default auth((req) => {
  const { pathname } = req.nextUrl

  if (shouldLogApiRequest(pathname)) {
    void logSystemEvent({
      source: "app",
      level: "info",
      message: "api_request",
      route: pathname,
      metadata: {
        method: req.method,
        authenticated: Boolean(req.auth?.user?.id),
      },
    })
  }

  if (!req.auth) {
    void logSystemEvent({
      source: "app",
      level: "warn",
      message: "auth_required_redirect",
      route: pathname,
      metadata: {
        method: req.method,
      },
    })
    return NextResponse.redirect(new URL("/login", req.url))
  }

  if (
    (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) &&
    req.auth.user?.role !== "admin"
  ) {
    void logSystemEvent({
      source: "app",
      level: "warn",
      message: "admin_access_denied_redirect",
      route: pathname,
      metadata: {
        method: req.method,
      },
    })
    return NextResponse.redirect(new URL("/dashboard", req.url))
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/settings/:path*",
    "/billing/:path*",
    "/api/s3/:path*",
    "/api/tasks/:path*",
    "/api/analytics/:path*",
    "/api/audit/:path*",
    "/admin/:path*",
    "/api/admin/:path*",
  ],
}
