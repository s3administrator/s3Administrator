# S3 Administrator

Local desktop S3 file manager (Electron) for AWS, Hetzner, Cloudflare R2, and any S3-compatible storage. Browse, upload, download, move, sync, and manage objects across multiple buckets and credentials from one app.

> Ships as a packaged macOS app (Apple Silicon). Run from source for development, or build a `.dmg` — `npm run dist:unsigned` for a local build, `npm run dist:notarized` for a signed + notarized release. See [BUILD_MACOS.md](BUILD_MACOS.md).

## Features

- Browse, upload, download, delete, move, rename objects
- Multi-credential, multi-bucket — AWS, Hetzner, R2, MinIO, Storadera, etc.
- Gallery view with image and video thumbnails
- Background tasks for copy / move / sync / migrate (parallel, resumable)
- Global search across indexed files
- Folder operations including recursive delete and batch ops
- Credentials encrypted at rest with AES-256-GCM (key derived per-install)
- Fully local — no account, no cloud, no telemetry. Embedded PostgreSQL stores metadata in the user data directory.

## Run

```bash
make install   # one-time: npm install + prisma generate
make run       # launches the Electron desktop app
```

`make run` boots embedded PostgreSQL, applies the Prisma schema, starts `next dev` and the task worker, then opens the desktop window — all from `electron/main.js`. To build a distributable app instead, see [BUILD_MACOS.md](BUILD_MACOS.md).

Per-install runtime data lives under `~/Library/Application Support/s3-administrator/`:
- `pgdata/` — embedded PostgreSQL data dir
- `secrets.json` — encryption key + pg password (mode 0600)

`make reset` wipes that directory if you want a clean slate.

## License

[GNU Affero General Public License v3.0](LICENSE).
