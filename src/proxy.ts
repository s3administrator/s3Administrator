import { auth } from "@/lib/auth"
import { NextResponse } from "next/server"

export default auth((req) => {
  const { pathname } = req.nextUrl

  if (!req.auth) {
    return NextResponse.redirect(new URL("/login", req.url))
  }

  if (
    (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) &&
    req.auth.user?.role !== "admin"
  ) {
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
    "/api/analytics/:path*",
    "/api/audit/:path*",
    "/admin/:path*",
    "/api/admin/:path*",
  ],
}
