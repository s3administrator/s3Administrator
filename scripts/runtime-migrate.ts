/**
 * Runtime schema migrator for the packaged desktop app.
 *
 * Replaces the dev-time `prisma db push` (which needs the Prisma CLI + schema
 * engine binary, too heavy to ship). At build time `build-desktop.mjs` emits
 * baseline SQL next to this file; here we apply any not-yet-applied .sql files
 * against the embedded Postgres and record them in `_app_migrations`.
 *
 * Bundled by esbuild to .next/standalone/migrate.js and forked by
 * electron/main.js with DATABASE_URL set. `pg` is resolved from the standalone
 * node_modules (kept external in the bundle).
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Client } from "pg"

const migrationsDir = join(__dirname, "migrations")

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required for migrations")

  const client = new Client({ connectionString })
  await client.connect()

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS "_app_migrations" (
         "name" text PRIMARY KEY,
         "applied_at" timestamptz NOT NULL DEFAULT now()
       )`
    )

    const { rows } = await client.query<{ name: string }>(
      `SELECT "name" FROM "_app_migrations"`
    )
    const applied = new Set(rows.map((r) => r.name))

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()

    let count = 0
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = readFileSync(join(migrationsDir, file), "utf8").trim()
      if (!sql) {
        await client.query(`INSERT INTO "_app_migrations" ("name") VALUES ($1)`, [file])
        continue
      }
      console.log(`[migrate] applying ${file}`)
      await client.query("BEGIN")
      try {
        await client.query(sql)
        await client.query(`INSERT INTO "_app_migrations" ("name") VALUES ($1)`, [file])
        await client.query("COMMIT")
        count++
      } catch (err) {
        await client.query("ROLLBACK")
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`)
      }
    }

    console.log(count === 0 ? "[migrate] schema up to date" : `[migrate] applied ${count} migration(s)`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error("[migrate] fatal:", err)
  process.exit(1)
})
