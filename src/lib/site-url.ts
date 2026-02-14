const DEFAULT_SITE_URL = "https://www.s3administrator.com"
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"])

function normalizeSiteUrl(raw: string | undefined): string {
  if (!raw) return DEFAULT_SITE_URL

  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_SITE_URL

  let withProtocol = trimmed
  if (!withProtocol.startsWith("http://") && !withProtocol.startsWith("https://")) {
    const hostPort = withProtocol.split("/")[0] || withProtocol
    const hostname = hostPort.split(":")[0]?.toLowerCase() || ""
    const protocol = LOCAL_HOSTNAMES.has(hostname) ? "http" : "https"
    withProtocol = `${protocol}://${withProtocol}`
  }

  try {
    // Validate and normalize user-provided URL from .env first.
    const parsed = new URL(withProtocol)
    return parsed.toString().replace(/\/+$/, "")
  } catch {
    return DEFAULT_SITE_URL
  }
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
