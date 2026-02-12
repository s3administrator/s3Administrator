import type { Metadata } from "next"
import { absoluteUrl } from "@/lib/site-url"

export const SITE_NAME = "S3 Admin"
export const DEFAULT_SITE_TITLE =
  "S3 File Manager for AWS, Hetzner & Cloudflare R2"
export const DEFAULT_SITE_DESCRIPTION =
  "Open source S3 file manager with bulk operations, recursive deletes, and cross-provider support for AWS, Hetzner, and Cloudflare R2."
export const DEFAULT_OG_IMAGE_PATH = "/opengraph-image"

type MarketingMetadataInput = {
  title: string
  description: string
  path: string
}

export function buildMarketingMetadata({
  title,
  description,
  path,
}: MarketingMetadataInput): Metadata {
  const canonicalPath = path.startsWith("/") ? path : `/${path}`
  const socialImageUrl = absoluteUrl(DEFAULT_OG_IMAGE_PATH)

  return {
    title,
    description,
    alternates: {
      canonical: canonicalPath,
    },
    openGraph: {
      title,
      description,
      url: absoluteUrl(canonicalPath),
      siteName: SITE_NAME,
      type: "website",
      images: [
        {
          url: socialImageUrl,
          width: 1200,
          height: 630,
          alt: `${title} | ${SITE_NAME}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImageUrl],
    },
  }
}
