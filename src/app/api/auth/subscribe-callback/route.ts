import { NextRequest, NextResponse } from "next/server"
import { stripe } from "@/lib/stripe"
import { prisma } from "@/lib/db"
import { randomUUID, randomBytes } from "crypto"

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session_id")
  if (!sessionId) {
    return NextResponse.redirect(new URL("/pricing?error=missing_session", req.url))
  }

  let stripeSession
  try {
    stripeSession = await stripe.checkout.sessions.retrieve(sessionId)
  } catch {
    return NextResponse.redirect(new URL("/pricing?error=invalid_session", req.url))
  }

  if (stripeSession.payment_status !== "paid") {
    return NextResponse.redirect(new URL("/pricing?error=unpaid", req.url))
  }

  const customerEmail = stripeSession.customer_details?.email
  const stripeCustomerId = stripeSession.customer as string
  const stripeSubId = stripeSession.subscription as string
  const planId = stripeSession.metadata?.planId
  const tier = stripeSession.metadata?.tier

  if (!customerEmail) {
    return NextResponse.redirect(new URL("/pricing?error=no_email", req.url))
  }

  // Find or create user — the webhook may or may not have run yet
  let user = await prisma.user.findUnique({
    where: { email: customerEmail },
  })

  if (!user) {
    try {
      user = await prisma.user.create({
        data: {
          email: customerEmail,
          emailVerified: new Date(),
          tier: tier || "free",
          stripeCustomerId,
          stripeSubscriptionId: stripeSubId,
        },
      })
    } catch (e: unknown) {
      // Race condition: webhook may have just created the user
      if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
        user = await prisma.user.findUnique({ where: { email: customerEmail } })
      } else {
        throw e
      }
    }

    // Create subscription record if user was just created here
    if (user && planId && stripeSubId) {
      const stripeSub = await stripe.subscriptions.retrieve(stripeSubId)
      const item = stripeSub.items.data[0]
      await prisma.subscription.upsert({
        where: { stripeSubscriptionId: stripeSubId },
        create: {
          userId: user.id,
          planId,
          stripeSubscriptionId: stripeSubId,
          stripeCustomerId,
          status: stripeSub.status,
          currentPeriodStart: new Date((item?.current_period_start ?? 0) * 1000),
          currentPeriodEnd: new Date((item?.current_period_end ?? 0) * 1000),
        },
        update: {},
      })
    }
  } else if (!user.stripeCustomerId) {
    // User exists (e.g. from OAuth) but webhook hasn't linked Stripe yet
    await prisma.user.update({
      where: { id: user.id },
      data: {
        tier: tier || user.tier,
        stripeCustomerId,
        stripeSubscriptionId: stripeSubId,
      },
    })
  }

  if (!user) {
    return NextResponse.redirect(new URL("/pricing?error=account_creation_failed", req.url))
  }

  // Create Auth.js database session
  const sessionToken = randomUUID() + randomBytes(16).toString("hex")
  const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days

  await prisma.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: sessionExpiry,
    },
  })

  // Set Auth.js session cookie and redirect to dashboard
  const useSecureCookies = process.env.AUTH_URL?.startsWith("https://") ?? false
  const cookieName = useSecureCookies
    ? "__Secure-authjs.session-token"
    : "authjs.session-token"

  const response = NextResponse.redirect(new URL("/dashboard", req.url))
  response.cookies.set(cookieName, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: useSecureCookies,
    expires: sessionExpiry,
  })

  return response
}
