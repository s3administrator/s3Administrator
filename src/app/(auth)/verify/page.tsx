"use client"

import { useSearchParams } from "next/navigation"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Mail } from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"

function VerifyContent() {
  const searchParams = useSearchParams()
  const email = searchParams.get("email")

  return (
    <Card>
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Mail className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-2xl">Check your email</CardTitle>
        <CardDescription>
          {email ? (
            <>
              We sent a sign in link to{" "}
              <span className="font-medium text-foreground">{email}</span>
            </>
          ) : (
            "We sent a sign in link to your email"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-center text-sm text-muted-foreground">
          Click the link in your email to sign in. The link will expire in 24
          hours.
        </p>
        <div className="text-center">
          <Button variant="ghost" asChild>
            <Link href="/login">Back to login</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyContent />
    </Suspense>
  )
}
