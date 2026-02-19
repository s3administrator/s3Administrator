import { Prisma, PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import pg from "pg"
import { logSystemEvent } from "@/lib/system-logger"

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient() {
  const databaseUrl = process.env.DATABASE_URL
  
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set. Please configure it to connect to PostgreSQL.")
  }
  
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const adapter = new PrismaPg(pool)
  
  const client = new PrismaClient({
    adapter,
    log: [
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
  })

  client.$on("warn", (event: Prisma.LogEvent) => {
    void logSystemEvent({
      source: "db",
      level: "warn",
      message: event.message,
      metadata: {
        target: event.target ?? null,
        timestamp: event.timestamp?.toISOString?.() ?? null,
      },
    })
  })

  client.$on("error", (event: Prisma.LogEvent) => {
    void logSystemEvent({
      source: "db",
      level: "error",
      message: event.message,
      metadata: {
        target: event.target ?? null,
        timestamp: event.timestamp?.toISOString?.() ?? null,
      },
    })
  })

  return client
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma
