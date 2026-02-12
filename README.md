This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Security Scanning (Semgrep pre-commit)

This repository includes a pre-commit hook configuration for Semgrep in `.pre-commit-config.yaml`.

Setup:

```bash
pre-commit install
```

Run on all files:

```bash
pre-commit run semgrep --all-files
```

The hook is configured with `p/security-audit` and runs automatically on staged files before each commit.

## Gallery Mode and Video Thumbnails

The dashboard supports `List` and `Gallery` mode.

- Gallery uses infinite scrolling and recursive listing under the current prefix.
- Image previews are loaded from signed S3 URLs.
- Video thumbnails are generated asynchronously by background tasks.

### Required environment variables (thumbnail storage)

Set these in `.env.dev` / `.env.prod`:

```bash
THUMBNAIL_S3_ENDPOINT=
THUMBNAIL_S3_REGION=
THUMBNAIL_S3_ACCESS_KEY=
THUMBNAIL_S3_SECRET_KEY=
THUMBNAIL_S3_BUCKET=
THUMBNAIL_MAX_WIDTH=480
THUMBNAIL_URL_TTL_SECONDS=3600
```

### Runtime requirement

The production app container installs `ffmpeg` and generates thumbnails in-process with:

- max 2 concurrent ffmpeg jobs per app instance
- 5 second timeout per thumbnail job

## SEO and Discovery

The app exposes SEO metadata routes:

- `/robots.txt`
- `/sitemap.xml`

Set canonical host via env:

```bash
NEXT_PUBLIC_SITE_URL=https://www.s3administrator.com
```

Post-deploy checklist:

1. Verify the domain in Google Search Console.
2. Submit `https://www.s3administrator.com/sitemap.xml`.
3. Confirm `robots.txt` allows public marketing pages and blocks private app/API paths.
4. Monitor indexing coverage and non-brand query impressions weekly.

## Environment Selection

Application scripts load env files based on `ENVIRONMENT`:

- `ENVIRONMENT=DEV` -> `.env.dev`
- `ENVIRONMENT=PROD` -> `.env.prod`

`DATABASE_URL` is required and the app build/start scripts fail fast when it is missing or empty.
