import { randomBytes, randomUUID } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod/v4"
import { prisma } from "@/lib/db"
import { getEnvironment } from "@/lib/env"

const communityLoginSchema = z.object({
  email: z.string().trim().email(),
})

const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean)

export async function POST(req: NextRequest) {
  if (getEnvironment() !== "COMMUNITY") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  const parsed = communityLoginSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 })
  }

  const email = parsed.data.email.toLowerCase()
  const shouldBeAdmin = adminEmails.includes(email)
  const now = new Date()

  let user = await prisma.user.findUnique({ where: { email } })

  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        emailVerified: now,
        role: shouldBeAdmin ? "admin" : "user",
      },
    })
  } else {
    const updates: { emailVerified?: Date; role?: string } = {}
    if (!user.emailVerified) updates.emailVerified = now
    if (shouldBeAdmin && user.role !== "admin") updates.role = "admin"
    if (Object.keys(updates).length > 0) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: updates,
      })
    }
  }

  const sessionToken = randomUUID() + randomBytes(16).toString("hex")
  const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  await prisma.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: sessionExpiry,
    },
  })

  await prisma.userActionEvent
    .create({
      data: {
        userId: user.id,
        eventType: "auth",
        eventName: "sign_in",
        path: "/api/auth/community-login",
        metadata: { email },
      },
    })
    .catch(() => null)

  const useSecureCookies = process.env.AUTH_URL?.startsWith("https://") ?? false
  const cookieName = useSecureCookies
    ? "__Secure-authjs.session-token"
    : "authjs.session-token"

  const response = NextResponse.json({ ok: true })
  response.cookies.set(cookieName, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: useSecureCookies,
    expires: sessionExpiry,
  })

  return response
}
