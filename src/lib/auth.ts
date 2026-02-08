import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import Google from "next-auth/providers/google"
import Resend from "next-auth/providers/resend"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "@/lib/db"
import { Resend as ResendClient } from "resend"

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return null
  return new ResendClient(apiKey)
}

const providers = []

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    })
  )
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  )
}

// Always add Resend provider, but handle sending differently based on environment
providers.push(
  Resend({
    apiKey: process.env.RESEND_API_KEY || "dummy-key-for-dev",
    from: process.env.EMAIL_FROM || "noreply@localhost",
    async sendVerificationRequest({ identifier: email, url }) {
      const apiKey = process.env.RESEND_API_KEY

      if (!apiKey || process.env.NODE_ENV === "development") {
        // Log to console in development or when API key is missing
        console.log("📧 Email Login Code (Dev Mode)")
        console.log(`To: ${email}`)
        console.log(`Sign in URL: ${url}`)
        return
      }

      // Use Resend in production
      const resend = getResendClient()
      if (!resend) return

      await resend.emails.send({
        from: process.env.EMAIL_FROM || "noreply@localhost",
        to: email,
        subject: "Sign in to S3 Admin",
        html: `
          <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #111; margin-bottom: 24px;">Sign in to S3 Admin</h2>
            <p style="color: #666; margin-bottom: 24px;">Click the link below to sign in to your account:</p>
            <a href="${url}" style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Sign In</a>
            <p style="color: #999; margin-top: 24px; font-size: 14px;">If you didn't request this email, you can safely ignore it.</p>
          </div>
        `,
      })
    },
  })
)

const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers,
  pages: {
    signIn: "/login",
    verifyRequest: "/verify",
  },
  events: {
    async signIn({ user }) {
      if (user.id && user.email && adminEmails.includes(user.email.toLowerCase())) {
        await prisma.user.update({
          where: { id: user.id },
          data: { role: "admin" },
        })
      }
    },
  },
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id
      session.user.role = user.role
      return session
    },
  },
  session: {
    strategy: "database",
  },
})
