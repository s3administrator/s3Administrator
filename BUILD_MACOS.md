# Building the macOS desktop app

S3 Administrator ships as a signed, notarized macOS `.app`/`.dmg` for Apple
Silicon. This document covers how the build works and how to produce a
distributable build with your Apple Developer ID.

## TL;DR

```bash
make install                 # one-time: npm install + prisma generate
npm run dist:unsigned        # build a local .dmg (no signing) -> release/
```

For a notarized release (needs an Apple Developer account, see below):

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDE12345"
npm run dist:notarized       # sign with Developer ID + notarize + staple
```

Output lands in `release/` (e.g. `release/S3 Administrator-0.1.0-arm64.dmg`).

## How the build is wired

The app is Electron wrapping the Next.js server + an embedded PostgreSQL. The
packaging has a few non-obvious moving parts:

- **`scripts/build-desktop.mjs`** (`npm run build:desktop`) produces everything
  the packaged app runs from:
  1. `prisma generate`
  2. `next build` → `.next/standalone/server.js` (Next standalone output)
  3. copies `.next/static` + `public/` into the standalone tree (standalone
     omits them)
  4. **overlays the complete `@prisma/*` packages** into the standalone
     `node_modules` — the Next tracer only copies their ESM builds, but the CJS
     worker needs the CJS entrypoints
  5. esbuild-bundles the task worker → `.next/standalone/worker.js` and the
     migration runner → `.next/standalone/migrate.js`
  6. generates the baseline schema SQL → `.next/standalone/migrations/0001_init.sql`

- **`electron-builder.yml`** packages it. Key choices:
  - `asar: false` — the app forks the Next server, worker, migrator, and the
    PostgreSQL binaries as child processes; plain files avoid asar pitfalls.
  - `npmRebuild: false` — `sharp`/`pg`/Postgres run under the **Node** ABI
    (via `ELECTRON_RUN_AS_NODE`), not Electron's native-addon ABI.
  - The only production `dependency` is `embedded-postgres`, so electron-builder
    bundles just that (+ its arm64 Postgres binaries) at the app root. Every
    other runtime dep lives inside the self-contained standalone bundle.
  - **`scripts/after-pack.cjs`** copies `.next/standalone` into the app verbatim
    (symlinks preserved). electron-builder strips/rewrites any `node_modules` it
    copies itself, which breaks the generated `.prisma/client`; the afterPack
    copy sidesteps that and runs before code signing.
  - **`scripts/after-all-artifact-build.cjs`** notarizes + staples the `.dmg`
    itself. electron-builder notarizes/staples the `.app` but not the `.dmg`
    container, and an unnotarized disk image is rejected by Gatekeeper on
    download. The hook runs only when Apple credentials are in the environment.

- **Schema on first run.** The packaged app no longer shells out to the Prisma
  CLI. `electron/main.js` forks `migrate.js`, which applies any not-yet-applied
  `migrations/*.sql` via `pg` and records them in an `_app_migrations` table.
  To evolve the schema, add a new numbered `.sql` file (the build currently
  emits a single `0001_init.sql` baseline from `prisma/schema.prisma`).

Per-install runtime data still lives under
`~/Library/Application Support/s3-administrator/` (embedded Postgres data dir +
`secrets.json`). `make reset` wipes it.

## Signing + notarization

### One-time setup

1. **Apple Developer Program membership** (the paid one — required for
   Developer ID signing and notarization).

2. **A "Developer ID Application" certificate** in your login keychain. Create
   it in Xcode (**Settings → Accounts → Manage Certificates → + → Developer ID
   Application**) or from the Apple Developer portal, then ensure it's in
   Keychain Access. electron-builder auto-discovers it — you do **not** need to
   set `CSC_LINK` for a local build.

   Verify it's there:
   ```bash
   security find-identity -v -p codesigning
   # look for: "Developer ID Application: Your Name (ABCDE12345)"
   ```
   That trailing 10-char code is your **Team ID**.

3. **Notarization credentials** — either an app-specific password or an App
   Store Connect API key.

   **Option A — app-specific password** (simplest):
   - Go to <https://account.apple.com> → Sign-In and Security → App-Specific
     Passwords → generate one.
   - ```bash
     export APPLE_ID="you@example.com"
     export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
     export APPLE_TEAM_ID="ABCDE12345"
     ```

   **Option B — App Store Connect API key** (better for CI):
   - App Store Connect → Users and Access → Integrations → App Store Connect
     API → generate a key with the *Developer* role; download the `.p8`.
   - ```bash
     export APPLE_API_KEY="/secure/path/AuthKey_XXXXXXXX.p8"
     export APPLE_API_KEY_ID="XXXXXXXX"
     export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
     ```

### Build it

```bash
npm run dist:notarized
```

This signs with your Developer ID, enables the hardened runtime with the
entitlements in `build/entitlements.mac.plist` (JIT + `disable-library-validation`,
required because the app loads the unsigned embedded Postgres binaries),
uploads to Apple for notarization, and staples the ticket to the `.dmg`.
Notarization typically takes a few minutes.

### Verify the result

```bash
APP="release/mac-arm64/S3 Administrator.app"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vvv -t install "$APP"          # should say: accepted, source=Notarized Developer ID
xcrun stapler validate "release/S3 Administrator-0.1.0-arm64.dmg"
```

## Notes / gotchas

- **Apple Silicon only.** The build targets `arm64`. A Universal (Intel + ARM)
  build additionally requires the Intel builds of `embedded-postgres` and
  `sharp`; add `x64` to `mac.target[].arch` in `electron-builder.yml` and
  install on/with both arches.
- **`appId`** is `com.s3administrator.desktop` in `electron-builder.yml`. Change
  it if you want a different bundle identifier; keep it stable across releases.
- **Not Mac App Store compatible.** App Store sandboxing forbids spawning a
  Postgres server and arbitrary child processes — this is a Developer ID /
  direct-distribution build only.
- The DMG is ~200 MB, mostly the bundled PostgreSQL 17 distribution (~133 MB)
  and Electron.
