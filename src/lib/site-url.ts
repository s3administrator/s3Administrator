const DEFAULT_SITE_URL = "https://www.s3administrator.com"

function normalizeSiteUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_SITE_URL

  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_SITE_URL

  const withProtocol =
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`

  return withProtocol.replace(/\/+$/, "")
}

export function getSiteUrl(): string {
  return normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL || process.env.AUTH_URL)
}

export function getSiteUrlObject(): URL {
  return new URL(`${getSiteUrl()}/`)
}

export function absoluteUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return new URL(normalizedPath, `${getSiteUrl()}/`).toString()
}
