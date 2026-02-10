import { PrismaClient } from "@prisma/client"
import Stripe from "stripe"

const prisma = new PrismaClient()

function getStripe(): Stripe | null {
  const key =
    process.env[`STRIPE_SECRET_KEY_${(process.env.ENVIRONMENT || "DEV").toUpperCase()}`] ||
    process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: "2026-01-28.clover" })
}

const defaultPlans = [
  {
    slug: "free",
    name: "Free",
    priceMonthly: 0,
    bucketLimit: 1,
    fileLimit: 1000,
    thumbnailCache: false,
    transferTasks: false,
    features: [],
    sortOrder: 0,
  },
  {
    slug: "starter",
    name: "Starter",
    priceMonthly: 300,
    bucketLimit: 10,
    fileLimit: 10000,
    thumbnailCache: false,
    transferTasks: false,
    features: ["Priority support"],
    sortOrder: 1,
  },
  {
    slug: "pro",
    name: "Pro",
    priceMonthly: 900,
    bucketLimit: 0,
    fileLimit: 100000,
    thumbnailCache: true,
    transferTasks: true,
    features: ["Priority support", "API access"],
    sortOrder: 2,
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    priceMonthly: 0,
    bucketLimit: 0,
    fileLimit: 0,
    thumbnailCache: true,
    transferTasks: true,
    features: ["Dedicated support", "Custom integrations", "SLA"],
    sortOrder: 3,
  },
]

async function main() {
  const stripe = getStripe()
  console.log("Seeding default plans...")
  if (!stripe) {
    console.log("  STRIPE_SECRET_KEY not set — skipping Stripe price creation")
  }

  for (const plan of defaultPlans) {
    const existing = await prisma.plan.findUnique({ where: { slug: plan.slug } })

    // Create Stripe product+price for paid plans that don't have one yet
    let stripePriceId = existing?.stripePriceId ?? null
    if (stripe && plan.priceMonthly > 0 && !stripePriceId) {
      console.log(`  Creating Stripe product+price for ${plan.slug}...`)
      const product = await stripe.products.create({
        name: plan.name,
        metadata: { slug: plan.slug },
      })
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: plan.priceMonthly,
        currency: "usd",
        recurring: { interval: "month" },
        metadata: { slug: plan.slug },
      })
      stripePriceId = price.id
    }

    await prisma.plan.upsert({
      where: { slug: plan.slug },
      update: {
        name: plan.name,
        bucketLimit: plan.bucketLimit,
        fileLimit: plan.fileLimit,
        thumbnailCache: plan.thumbnailCache,
        transferTasks: plan.transferTasks,
        features: plan.features,
        sortOrder: plan.sortOrder,
        ...(stripePriceId && !existing?.stripePriceId ? { stripePriceId } : {}),
      },
      create: { ...plan, stripePriceId },
    })
    console.log(`  Upserted plan: ${plan.slug}${stripePriceId ? ` (price: ${stripePriceId})` : ""}`)
  }

  console.log("Seeding complete.")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
