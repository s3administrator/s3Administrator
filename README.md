# S3 Administrator

Open-source S3 file manager for Hetzner, AWS, Cloudflare R2, and any S3-compatible storage provider. Browse, upload, download, move, and manage files across multiple buckets and providers from a single dashboard.

## Features

- **File Management** - Browse, upload, download, delete, move, and rename files
- **Multi-Provider** - Connect to AWS S3, Hetzner Object Storage, Cloudflare R2, or any S3-compatible endpoint
- **Multi-Bucket** - Manage multiple buckets across multiple credentials
- **Gallery View** - Visual gallery with image previews and video thumbnail generation
- **Background Tasks** - Copy, move, sync, and migrate files between buckets
- **Global Search** - Search across all indexed files and buckets
- **Folder Operations** - Create folders, recursive delete, batch operations
- **Encrypted Credentials** - S3 keys are encrypted at rest with AES-256-GCM
- **Self-Hosted** - Run on your own infrastructure with Docker Compose

## Quick Start

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/s3-administrator.git
cd s3-administrator

# Choose a template and copy to runtime env
cp .env.community .env
# or: cp .env.cloud .env

# Fill in required values in .env:
#   - DATABASE_URL
#   - AUTH_SECRET (generate with: openssl rand -base64 32)
#   - ENCRYPTION_MASTER_KEY (generate with: openssl rand -hex 32)
#   - ENCRYPTION_SALT (generate with: openssl rand -hex 16)

# Start with Docker Compose
docker compose --env-file .env -f docker/docker-compose.yml up -d

# Run database migrations and seed
docker compose --env-file .env -f docker/docker-compose.yml exec app npx prisma migrate deploy
docker compose --env-file .env -f docker/docker-compose.yml exec app npx prisma db seed

# Open http://localhost:3000
```

## Community vs Cloud

| Feature | Community (Self-Hosted) | Cloud (s3administrator.com) |
|---------|:-:|:-:|
| File browsing & management | Yes | Yes |
| Multi-provider & multi-bucket | Yes | Yes |
| Gallery view & thumbnails | Yes | Yes |
| Background tasks & sync | Yes | Yes |
| Global file search | Yes | Yes |
| Folder operations | Yes | Yes |
| Encrypted credentials | Yes | Yes |
| **Multi-user auth (OAuth, email)** | - | Yes |
| **Billing & subscription plans** | - | Yes |
| **Audit logs** | - | Yes |
| **Admin panel** | - | Yes |
| **Managed hosting & updates** | - | Yes |
| **Support & SLA** | - | Yes |

The community edition is a single-user, no-auth tool designed for personal or internal use. All S3 management features are fully unlocked.

For multi-user support, audit logs, and managed hosting, see [s3administrator.com](https://www.s3administrator.com).

## Development

```bash
# Install dependencies
npm install

# Copy community template to runtime env
cp .env.community .env

# Start PostgreSQL
docker compose --env-file .env -f docker/docker-compose.yml up db -d

# Run migrations and seed
npx prisma migrate deploy
npx prisma db seed

# Start app
npm run dev
```

## Make Commands

```bash
# Community profile
make community-setup
make community-start

# Cloud profile
make cloud-setup
make cloud-start
make cloud-local
make cloud-start-prod

# Logs
make log PROFILE=community
make log PROFILE=cloud
```

`cloud-start` runs `app + db + proxy` and always starts Caddy.
`cloud-start-prod` is a compatibility alias to `cloud-start`.

Caddy now uses a single config file: `docker/Caddyfile`.
It reads `DOMAIN`, `ROOT_DOMAIN`, and `CADDY_SITE_ADDRESSES` from `.env`.

For local cloud development, keep cloud mode but point URLs to localhost in `.env`:

```bash
ENVIRONMENT="CLOUD"
NEXT_PUBLIC_EDITION="cloud"
AUTH_URL="http://localhost:3000"
NEXT_PUBLIC_SITE_URL="http://localhost:3000"
```

## Environment Contract

Application runtime reads only `.env`.

- `ENVIRONMENT` must be `COMMUNITY` or `CLOUD`
- `envVar("KEY")` lookup order:
1. `KEY_COMMUNITY` or `KEY_CLOUD` (based on `ENVIRONMENT`)
2. `KEY` (unsuffixed fallback)

## Gallery Mode and Video Thumbnails

The dashboard supports List and Gallery view modes.

- Gallery uses infinite scrolling with recursive listing
- Image previews loaded from signed S3 URLs
- Video thumbnails generated asynchronously via ffmpeg

Optional environment variables for thumbnail storage:

```bash
THUMBNAIL_S3_ENDPOINT=
THUMBNAIL_S3_REGION=
THUMBNAIL_S3_ACCESS_KEY=
THUMBNAIL_S3_SECRET_KEY=
THUMBNAIL_S3_BUCKET=
THUMBNAIL_MAX_WIDTH=480
THUMBNAIL_URL_TTL_SECONDS=3600
```

## Security Scanning (pre-commit)

Pre-commit hooks are configured in `.pre-commit-config.yaml`:

- Semgrep (`p/security-audit`)
- OSV scanner (`package-lock.json`)
- SonarQube (optional, runs when env vars are set)

```bash
pre-commit install
pre-commit run --all-files
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
