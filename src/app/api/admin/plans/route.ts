import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { z } from "zod/v4"

const createPlanSchema = z.object({
  slug: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  priceMonthly: z.number().int().min(0),
  bucketLimit: z.number().int().min(0),
  fileLimit: z.number().int().min(0),
  features: z.array(z.string()).default([]),
  sortOrder: z.number().int().default(0),
})

export async function GET() {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const plans = await prisma.plan.findMany({
    orderBy: { sortOrder: "asc" },
    include: { _count: { select: { subscriptions: true } } },
  })

  return NextResponse.json({ plans })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await req.json()
  const parsed = createPlanSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 })
  }

  const { slug, name, priceMonthly, bucketLimit, fileLimit, features, sortOrder } = parsed.data

  const existing = await prisma.plan.findUnique({ where: { slug } })
  if (existing) {
    return NextResponse.json({ error: "A plan with this slug already exists" }, { status: 409 })
  }

  let stripePriceId: string | null = null

  if (priceMonthly > 0) {
    const product = await stripe.products.create({
      name,
      metadata: { slug },
    })

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: priceMonthly,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { slug },
    })

    stripePriceId = price.id
  }

  const plan = await prisma.plan.create({
    data: {
      slug,
      name,
      priceMonthly,
      stripePriceId,
      bucketLimit,
      fileLimit,
      features,
      sortOrder,
    },
  })

  return NextResponse.json({ plan }, { status: 201 })
}
