import { NextRequest, NextResponse } from "next/server"
import { stripe } from "@/lib/stripe"
import { prisma } from "@/lib/db"
import { enforceThumbnailCachePolicyForUser } from "@/lib/thumbnail-cache-policy"
import { randomUUID, randomBytes } from "crypto"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"

function getSafeRedirectPath(path: string | null, fallback: string): string {
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallback
  }
  return path
}

function redirectWithError(req: NextRequest, path: string, error: string) {
  const target = new URL(path, req.url)
  target.searchParams.set("error", error)
  return NextResponse.redirect(target)
}

function getPeriodDates(sub: Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>) {
  const item = sub.items.data[0]
  return {
    start: new Date((item?.current_period_start ?? 0) * 1000),
    end: new Date((item?.current_period_end ?? 0) * 1000),
  }
}

export async function GET(req: NextRequest) {
  const successPath = getSafeRedirectPath(
    req.nextUrl.searchParams.get("next"),
    "/dashboard",
  )
  const errorPath = getSafeRedirectPath(
    req.nextUrl.searchParams.get("next"),
    "/pricing",
  )

  const sessionId = req.nextUrl.searchParams.get("session_id")
  if (!sessionId) {
    return redirectWithError(req, errorPath, "missing_session")
  }

  let stripeSession
  try {
    stripeSession = await stripe.checkout.sessions.retrieve(sessionId)
  } catch {
    return redirectWithError(req, errorPath, "invalid_session")
  }

  if (!["paid", "no_payment_required"].includes(stripeSession.payment_status)) {
    return redirectWithError(req, errorPath, "unpaid")
  }

  const userId = stripeSession.metadata?.userId
  const planId = stripeSession.metadata?.planId
  const customerEmail = stripeSession.customer_details?.email ?? stripeSession.customer_email
  const stripeCustomerId =
    typeof stripeSession.customer === "string"
      ? stripeSession.customer
      : stripeSession.customer?.id ?? null
  const stripeSubId =
    typeof stripeSession.subscription === "string"
      ? stripeSession.subscription
      : stripeSession.subscription?.id ?? null

  if (!stripeSubId) {
    return redirectWithError(req, errorPath, "missing_subscription")
  }

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId)
  const stripePriceId = stripeSub.items.data[0]?.price?.id
  const resolvedPlan =
    (planId ? await prisma.plan.findUnique({ where: { id: planId } }) : null) ??
    (stripePriceId
      ? await prisma.plan.findUnique({ where: { stripePriceId } })
      : null)

  if (!resolvedPlan) {
    return redirectWithError(req, errorPath, "invalid_plan")
  }

  // Find or create user — prefer metadata.userId for authenticated checkout,
  // then fall back to email for guest checkout.
  let user = userId
    ? await prisma.user.findUnique({
        where: { id: userId },
      })
    : null

  if (!user && customerEmail) {
    user = await prisma.user.findUnique({
      where: { email: customerEmail },
    })
  }

  if (!user && !customerEmail) {
    return redirectWithError(req, errorPath, "no_user")
  }

  if (!user && customerEmail) {
    try {
      user = await prisma.user.create({
        data: {
          email: customerEmail,
          emailVerified: new Date(),
          stripeCustomerId: stripeCustomerId ?? undefined,
        },
      })
    } catch (e: unknown) {
      // Race condition: webhook may have just created the user.
      if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
        user = await prisma.user.findUnique({ where: { email: customerEmail } })
      } else {
        throw e
      }
    }
  }

  if (!user) {
    return redirectWithError(req, errorPath, "account_creation_failed")
  }

  const resolvedCustomerId = stripeCustomerId ?? user.stripeCustomerId
  if (!resolvedCustomerId) {
    return redirectWithError(req, errorPath, "missing_customer")
  }

  if (user.stripeCustomerId !== resolvedCustomerId) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        stripeCustomerId: resolvedCustomerId,
      },
    })
  }

  const period = getPeriodDates(stripeSub)

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: stripeSubId },
    create: {
      userId: user.id,
      planId: resolvedPlan.id,
      stripeSubscriptionId: stripeSubId,
      stripeCustomerId: resolvedCustomerId,
      status: stripeSub.status,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    },
    update: {
      userId: user.id,
      planId: resolvedPlan.id,
      stripeCustomerId: resolvedCustomerId,
      status: stripeSub.status,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    },
  })

  await prisma.subscription.updateMany({
    where: {
      userId: user.id,
      status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] },
      NOT: { stripeSubscriptionId: stripeSubId },
    },
    data: {
      status: "canceled",
      cancelAtPeriodEnd: false,
      canceledAt: new Date(),
    },
  })

  await enforceThumbnailCachePolicyForUser(user.id)

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

  const response = NextResponse.redirect(new URL(successPath, req.url))
  response.cookies.set(cookieName, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: useSecureCookies,
    expires: sessionExpiry,
  })

  return response
}
