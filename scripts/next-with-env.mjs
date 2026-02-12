#!/usr/bin/env node
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import dotenv from "dotenv"

const [nextCommand = "dev", ...nextArgs] = process.argv.slice(2)

if (!["dev", "build", "start"].includes(nextCommand)) {
  console.error(
    `Unsupported next command "${nextCommand}". Expected one of: dev, build, start.`,
  )
  process.exit(1)
}

const environment = (process.env.ENVIRONMENT ?? "DEV").toUpperCase()
const envFile = environment === "PROD" ? ".env.prod" : ".env.dev"
const envPath = resolve(process.cwd(), envFile)

if (!existsSync(envPath)) {
  console.error(`Missing required env file: ${envFile} (${envPath})`)
  process.exit(1)
}

dotenv.config({ path: envPath, override: false, quiet: true })

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) {
  console.error(
    `DATABASE_URL is required but missing/empty after loading ${envFile}.`,
  )
  process.exit(1)
}

const require = createRequire(import.meta.url)
const nextBinPath = require.resolve("next/dist/bin/next")
const child = spawn(process.execPath, [nextBinPath, nextCommand, ...nextArgs], {
  stdio: "inherit",
  env: process.env,
})

child.on("error", (error) => {
  console.error("Failed to launch Next.js command.", error)
  process.exit(1)
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
