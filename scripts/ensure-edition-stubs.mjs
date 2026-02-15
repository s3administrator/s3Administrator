#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

function parseEnvironment(explicitEnvironment) {
  const direct = explicitEnvironment?.trim().toUpperCase()
  if (direct === "COMMUNITY" || direct === "CLOUD") return direct
  if (direct) {
    throw new Error(`Unsupported environment "${explicitEnvironment}". Expected COMMUNITY or CLOUD.`)
  }

  const fromEnv = process.env.ENVIRONMENT?.trim().toUpperCase()
  if (fromEnv === "COMMUNITY" || fromEnv === "CLOUD") return fromEnv

  const edition = process.env.NEXT_PUBLIC_EDITION?.trim().toLowerCase()
  return edition === "cloud" ? "CLOUD" : "COMMUNITY"
}

function findFirstExisting(paths) {
  return paths.find((candidate) => existsSync(candidate)) ?? null
}

function runSetupScript(scriptPath, label) {
  const result = spawnSync(process.execPath, ["--import=tsx", scriptPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  })

  if (result.error) {
    throw result.error
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.`)
  }
}

function disableDevLoginRoute(projectRoot) {
  const routePath = resolve(projectRoot, "src/app/api/auth/dev-login/route.ts")
  const routeDir = dirname(routePath)

  if (!existsSync(routeDir)) {
    mkdirSync(routeDir, { recursive: true })
  }

  const content = [
    "// Disabled intentionally: legacy dev auth bypass is not supported.",
    'import { NextResponse } from "next/server"',
    "",
    'export const POST = () => NextResponse.json({ error: "Not found" }, { status: 404 })',
    "",
  ].join("\n")

  writeFileSync(routePath, content, "utf-8")
  console.log("✓ Disabled legacy /api/auth/dev-login route")
}

function enforceCloudPricingPageRoute(projectRoot) {
  const pagePath = resolve(projectRoot, "src/app/(marketing)/pricing/page.tsx")
  const pageDir = dirname(pagePath)

  if (!existsSync(pageDir)) {
    mkdirSync(pageDir, { recursive: true })
  }

  const content = [
    "// Ensures /pricing is always runtime-rendered in cloud mode.",
    'export const dynamic = "force-dynamic"',
    'export { metadata } from "@s3administrator/marketing/pages/pricing"',
    'export { default } from "@s3administrator/marketing/pages/pricing"',
    "",
  ].join("\n")

  writeFileSync(pagePath, content, "utf-8")
  console.log("✓ Forced runtime rendering for /pricing in cloud mode")
}

export function ensureEditionStubs(explicitEnvironment) {
  const environment = parseEnvironment(explicitEnvironment)
  const root = process.cwd()
  const communitySetupPath = findFirstExisting([
    resolve(root, "packages/community-setup/bin/s3admin-community-setup.mjs"),
    resolve(root, "node_modules/@s3administrator/community-setup/bin/s3admin-community-setup.mjs"),
  ])
  const cloudSetupPath = resolve(root, "node_modules/@s3administrator/setup/bin/s3admin-setup.mjs")
  const hasCloudSetup = existsSync(cloudSetupPath)

  if (environment === "CLOUD") {
    if (!hasCloudSetup) {
      throw new Error(
        "Cloud setup package not found. Install @s3administrator/setup and cloud packages, or use ENVIRONMENT=COMMUNITY.",
      )
    }

    runSetupScript(cloudSetupPath, "Cloud setup")
    enforceCloudPricingPageRoute(root)
    disableDevLoginRoute(root)
    return
  }

  if (!communitySetupPath) {
    throw new Error(
      "Community setup package not found. Install @s3administrator/community-setup (public package) or add packages/community-setup locally.",
    )
  }

  runSetupScript(communitySetupPath, "Community setup")
  disableDevLoginRoute(root)
}

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isDirectRun) {
  try {
    ensureEditionStubs(process.argv[2])
  } catch (error) {
    console.error("Edition stub setup failed.", error)
    process.exit(1)
  }
}
