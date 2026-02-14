import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { isCommunityEdition } from "@/lib/edition"
import { prisma } from "@/lib/db"

const LOCAL_USER = {
  id: "local",
  name: "Local User",
  email: "local@localhost",
  role: "admin",
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"])

function normalizeUrlEnvVar(key: "AUTH_URL" | "NEXT_PUBLIC_SITE_URL") {
  const raw = process.env[key]?.trim()
  if (!raw) return

  if (raw.startsWith("http://") || raw.startsWith("https://")) return

  const hostPort = raw.split("/")[0] || raw
  const hostname = hostPort.split(":")[0]?.toLowerCase() || ""
  const protocol = LOCAL_HOSTNAMES.has(hostname) ? "http" : "https"
  const normalized = `${protocol}://${raw}`
  process.env[key] = normalized

  console.warn(`${key} did not include protocol; normalized to ${normalized}`)
}

// Auth.js expects absolute URL env values. Normalize bare hostnames like "localhost".
normalizeUrlEnvVar("AUTH_URL")
normalizeUrlEnvVar("NEXT_PUBLIC_SITE_URL")

async function ensureLocalUser() {
  await prisma.user.upsert({
    where: { id: LOCAL_USER.id },
    update: {},
    create: {
      id: LOCAL_USER.id,
      name: LOCAL_USER.name,
      email: LOCAL_USER.email,
      role: LOCAL_USER.role,
    },
  })
}

function buildCommunityAuth() {
  return NextAuth({
    providers: [
      Credentials({
        credentials: {},
        async authorize() {
          await ensureLocalUser()
          return LOCAL_USER
        },
      }),
    ],
    callbacks: {
      jwt({ token }) {
        token.id = LOCAL_USER.id
        token.role = LOCAL_USER.role
        return token
      },
      session({ session }) {
        session.user.id = LOCAL_USER.id
        session.user.role = LOCAL_USER.role
        return session
      },
    },
    session: { strategy: "jwt" },
    pages: { signIn: "/login" },
    secret: process.env.AUTH_SECRET || "community-edition-secret",
  })
}

type AuthModule = ReturnType<typeof buildCommunityAuth>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _authModule: AuthModule | null = null

const _ready: Promise<AuthModule> = isCommunityEdition()
  ? Promise.resolve(buildCommunityAuth())
  : (async () => {
      try {
        const pkg = "@s3administrator/auth"
        const mod = await import(pkg)
        return mod as unknown as AuthModule
      } catch {
        console.warn("@s3administrator/auth not available — falling back to community auth")
        return buildCommunityAuth()
      }
    })()

_ready.then((m) => {
  _authModule = m
})

export const handlers = {
  GET: async (...args: Parameters<AuthModule["handlers"]["GET"]>) => {
    const m = await _ready
    return m.handlers.GET(...args)
  },
  POST: async (...args: Parameters<AuthModule["handlers"]["POST"]>) => {
    const m = await _ready
    return m.handlers.POST(...args)
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const auth: AuthModule["auth"] = ((...args: any[]) => {
  // Fast path: if the module is already resolved, delegate immediately.
  if (_authModule) {
    return (_authModule.auth as (...a: unknown[]) => unknown)(...args)
  }
  // auth() has two calling conventions in Auth.js v5:
  //   1. auth()              → returns Promise<Session> (server components / route handlers)
  //   2. auth(callback)      → returns middleware function (proxy.ts)
  // For case 2 the outer call happens at import time (before _ready settles),
  // so we return a wrapper that awaits _ready on each request.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (req: any, ctx: any) => {
    const m = await _ready
    const innerAuth = m.auth as (...a: unknown[]) => unknown
    const middleware = innerAuth(...args) as (r: unknown, c: unknown) => unknown
    return middleware(req, ctx)
  }) as unknown
}) as AuthModule["auth"]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const signIn: AuthModule["signIn"] = (async (...args: any[]) => {
  const m = await _ready
  return (m.signIn as (...a: unknown[]) => unknown)(...args)
}) as AuthModule["signIn"]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const signOut: AuthModule["signOut"] = (async (...args: any[]) => {
  const m = await _ready
  return (m.signOut as (...a: unknown[]) => unknown)(...args)
}) as AuthModule["signOut"]
