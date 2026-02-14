"use client"

import { useState } from "react"
import { signIn } from "next-auth/react"
import { useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Github, Loader2 } from "lucide-react"

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState<string | null>(null)
  const [authErrorMessage, setAuthErrorMessage] = useState<string | null>(null)
  const { status } = useSession()
  const router = useRouter()
  const isCommunity = (process.env.NEXT_PUBLIC_EDITION || "").trim().toLowerCase() !== "cloud"

  useEffect(() => {
    if (isCommunity) {
      // Auto-sign in for community edition (single-user, no auth)
      signIn("credentials", { redirect: false }).then(() => {
        router.replace("/dashboard")
      })
      return
    }
    if (status === "authenticated") {
      router.replace("/dashboard")
    }
  }, [status, router, isCommunity])

  useEffect(() => {
    const authError = new URLSearchParams(window.location.search).get("error")
    const message =
      authError === "OAuthAccountNotLinked"
        ? "This email is already used by another sign-in method. Try signing in with your existing method first, then connect this provider."
        : authError
          ? "Sign in failed. Please try again."
          : null

    setAuthErrorMessage(message)
  }, [])

  async function handleEmailSignIn(e: React.FormEvent) {
    e.preventDefault()
    const normalizedEmail = email.trim()
    if (!normalizedEmail) return

    setIsLoading(true)
    setAuthErrorMessage(null)
    try {
      const communityLoginResponse = await fetch("/api/auth/community-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail }),
      })

      if (communityLoginResponse.ok) {
        window.location.assign("/dashboard")
        return
      }

      if (communityLoginResponse.status !== 404) {
        throw new Error("community_login_failed")
      }

      await signIn("resend", {
        email: normalizedEmail,
        redirect: false,
        callbackUrl: "/dashboard",
      })
      router.push(`/verify?email=${encodeURIComponent(normalizedEmail)}`)
    } catch {
      setAuthErrorMessage("Sign in failed. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  async function handleOAuthSignIn(provider: string) {
    setOauthLoading(provider)
    await signIn(provider, { callbackUrl: "/dashboard" })
  }

  if (status === "authenticated") {
    return null
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>
          Sign in to manage your S3 storage
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {authErrorMessage ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {authErrorMessage}
          </div>
        ) : null}

        <form onSubmit={handleEmailSignIn} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Continue with Email
          </Button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <Separator />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => handleOAuthSignIn("github")}
            disabled={oauthLoading !== null}
          >
            {oauthLoading === "github" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Github className="mr-2 h-4 w-4" />
            )}
            Continue with GitHub
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => handleOAuthSignIn("google")}
            disabled={oauthLoading !== null}
          >
            {oauthLoading === "google" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
            )}
            Continue with Google
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
