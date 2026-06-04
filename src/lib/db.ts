import { Prisma, PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function getDbPoolMax(): number {
  const raw = process.env.DATABASE_POOL_MAX
  if (!raw) return 8
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return 8
  return Math.min(64, Math.max(1, parsed))
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    max: getDbPoolMax(),
  })
  const client = new PrismaClient({
    adapter,
    log: [
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
  })

  client.$on("warn", (event: Prisma.LogEvent) => {
    console.warn("[db]", event.message)
  })

  client.$on("error", (event: Prisma.LogEvent) => {
    console.error("[db]", event.message)
  })

  return client
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma
