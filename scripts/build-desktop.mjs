#!/usr/bin/env node
/**
 * Desktop production build orchestrator.
 *
 * Turns the dev-only Electron app into a packaged-ready tree:
 *   1. prisma generate            — regenerate the client
 *   2. next build                 — produces .next/standalone/server.js
 *   3. copy .next/static + public — standalone does NOT copy these itself
 *   4. bundle the task worker     — src/worker/task-worker.ts -> standalone/worker.js
 *   5. bundle the migration runner — scripts/runtime-migrate.ts -> standalone/migrate.js
 *   6. generate the baseline SQL  — prisma migrate diff -> standalone/migrations/*.sql
 *
 * Run via `npm run build:desktop`. electron-builder (`npm run dist`) consumes
 * the resulting .next/standalone tree.
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build as esbuild } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const standalone = join(root, ".next", "standalone")

function run(cmd, args, extraEnv = {}) {
  console.log(`\n› ${cmd} ${args.join(" ")}`)
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: false,
  })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${res.status}`)
  }
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx"

// 1. Prisma client
run(npx, ["prisma", "generate"])

// 2. Next build (standalone). DATABASE_URL is unused at build time but the env
//    helper still wants ENVIRONMENT set; provide a community default.
run("node", ["scripts/next-with-env.mjs", "build"], { ENVIRONMENT: "COMMUNITY" })

if (!existsSync(join(standalone, "server.js"))) {
  throw new Error("Expected .next/standalone/server.js after next build — is output:'standalone' set?")
}

// 3. Copy assets standalone omits.
console.log("\n› copying .next/static and public into standalone")
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true })
if (existsSync(join(root, "public"))) {
  cpSync(join(root, "public"), join(standalone, "public"), { recursive: true })
}

// 3b. The standalone tracer copies only the ESM build of the @prisma adapter
// packages (the Next server is ESM). Our CJS worker requires their CJS
// entrypoints (dist/index.js), which the trace omits — so the worker process
// crashes on load. Overlay the complete, same-version packages from the root
// node_modules so both module formats are present.
console.log("\n› overlaying complete @prisma packages into standalone (CJS worker support)")
const prismaScope = join(standalone, "node_modules", "@prisma")
for (const name of readdirSync(prismaScope)) {
  const full = join(root, "node_modules", "@prisma", name)
  if (existsSync(full)) {
    const target = join(prismaScope, name)
    rmSync(target, { recursive: true, force: true })
    cpSync(full, target, { recursive: true })
  }
}

// 4 & 5. Bundle the worker and the migration runner into the standalone dir.
//    @/ alias -> src/. Native / heavy packages stay external and resolve from
//    the standalone node_modules the Next tracer already produced.
const externals = [
  "@prisma/client",
  ".prisma/client",
  "@prisma/adapter-pg",
  "pg",
  "pg-native",
  "sharp",
  "@img/*",
]

async function bundle(entry, outfile) {
  console.log(`\n› bundling ${entry} -> ${outfile}`)
  await esbuild({
    entryPoints: [join(root, entry)],
    outfile: join(standalone, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: externals,
    alias: { "@": join(root, "src") },
    logLevel: "info",
    sourcemap: false,
    legalComments: "none",
  })
}

await bundle("src/worker/task-worker.ts", "worker.js")
await bundle("scripts/runtime-migrate.ts", "migrate.js")

// 6. Baseline SQL migration from the current schema (build-time only; uses the
//    dev machine's prisma schema engine, never shipped).
const migrationsOut = join(standalone, "migrations")
rmSync(migrationsOut, { recursive: true, force: true })
mkdirSync(migrationsOut, { recursive: true })
const baseline = join(migrationsOut, "0001_init.sql")
console.log(`\n› generating baseline SQL -> ${baseline}`)
run(npx, [
  "prisma",
  "migrate",
  "diff",
  "--from-empty",
  "--to-schema",
  "prisma/schema.prisma",
  "--script",
  "--output",
  baseline,
])

const applied = readdirSync(migrationsOut)
console.log(`\n✓ desktop build ready. Migrations bundled: ${applied.join(", ")}`)
