import { NextResponse } from "next/server"
import { prisma } from "@/lib/db"

export async function GET() {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      priceMonthly: true,
      bucketLimit: true,
      fileLimit: true,
      features: true,
      thumbnailCache: true,
      stripePriceId: true,
    },
  })

  return NextResponse.json({ plans })
}
