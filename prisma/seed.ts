import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

const defaultPlans = [
  {
    slug: "free",
    name: "Free",
    priceMonthly: 0,
    bucketLimit: 1,
    fileLimit: 1000,
    features: [],
    sortOrder: 0,
  },
  {
    slug: "starter",
    name: "Starter",
    priceMonthly: 300,
    bucketLimit: 10,
    fileLimit: 10000,
    features: ["Priority support"],
    sortOrder: 1,
  },
  {
    slug: "pro",
    name: "Pro",
    priceMonthly: 900,
    bucketLimit: 0,
    fileLimit: 100000,
    features: ["Priority support", "API access"],
    sortOrder: 2,
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    priceMonthly: 0,
    bucketLimit: 0,
    fileLimit: 0,
    features: ["Dedicated support", "Custom integrations", "SLA"],
    sortOrder: 3,
  },
]

async function main() {
  console.log("Seeding default plans...")

  for (const plan of defaultPlans) {
    await prisma.plan.upsert({
      where: { slug: plan.slug },
      update: {
        name: plan.name,
        bucketLimit: plan.bucketLimit,
        fileLimit: plan.fileLimit,
        features: plan.features,
        sortOrder: plan.sortOrder,
      },
      create: plan,
    })
    console.log(`  Upserted plan: ${plan.slug}`)
  }

  console.log("Seeding complete.")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
