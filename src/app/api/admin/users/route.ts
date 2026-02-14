import { NextResponse } from "next/server"
import { communityGuard } from "@/lib/api-guard";
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status"

export async function GET(req: Request) {
  const _guard = communityGuard(); if (_guard) return _guard;
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { searchParams } = new URL(req.url)
  const page = parseInt(searchParams.get("page") ?? "1", 10)
  const limit = 20
  const skip = (page - 1) * limit

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        stripeCustomerId: true,
        createdAt: true,
        subscriptions: {
          where: { status: { in: [...ACTIVE_SUBSCRIPTION_STATUSES] } },
          orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
          take: 1,
          select: {
            stripeSubscriptionId: true,
            plan: { select: { slug: true } },
          },
        },
        _count: {
          select: { s3Credentials: true, fileMetadata: true },
        },
      },
    }),
    prisma.user.count(),
  ])

  return NextResponse.json({
    users: users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tier: user.subscriptions[0]?.plan.slug ?? "free",
      stripeCustomerId: user.stripeCustomerId,
      stripeSubscriptionId: user.subscriptions[0]?.stripeSubscriptionId ?? null,
      createdAt: user.createdAt,
      _count: user._count,
    })),
    total,
    page,
    limit,
  })
}
