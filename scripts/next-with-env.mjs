#!/usr/bin/env node
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import dotenv from "dotenv"
import { ensureEditionStubs } from "./ensure-edition-stubs.mjs"

const [nextCommand = "dev", ...nextArgs] = process.argv.slice(2)

if (!["dev", "build", "start"].includes(nextCommand)) {
  console.error(
    `Unsupported next command "${nextCommand}". Expected one of: dev, build, start.`,
  )
  process.exit(1)
}

const envFile = ".env"
const envPath = resolve(process.cwd(), envFile)

if (existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false, quiet: true })
} else {
  console.warn(`Optional env file not found: ${envFile} (${envPath}); using process env.`)
}

const environment = process.env.ENVIRONMENT?.trim().toUpperCase()
if (environment !== "COMMUNITY" && environment !== "CLOUD") {
  console.error('ENVIRONMENT must be set to either "COMMUNITY" or "CLOUD".')
  process.exit(1)
}

try {
  ensureEditionStubs(environment)
} catch (error) {
  console.error("Failed to prepare edition stubs.", error)
  process.exit(1)
}

if (nextCommand !== "build") {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error(
      `DATABASE_URL is required but missing/empty after loading ${envFile}.`,
    )
    process.exit(1)
  }
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
