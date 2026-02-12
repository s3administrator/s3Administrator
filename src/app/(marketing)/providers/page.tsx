import type { Metadata } from "next"
import { SeoLandingIndex } from "@/components/marketing/seo-landing-index"
import { buildMarketingMetadata } from "@/lib/seo"
import { getSeoLandingPagesByCategory } from "@/lib/seo-landing-pages"

export const metadata: Metadata = buildMarketingMetadata({
  title: "S3 Provider Guides (AWS, Hetzner, R2)",
  description:
    "Provider-specific S3 management guides for AWS S3, Hetzner Object Storage, and Cloudflare R2.",
  path: "/providers",
})

export default function ProvidersIndexPage() {
  const pages = getSeoLandingPagesByCategory("providers")

  return <SeoLandingIndex category="providers" pages={pages} />
}
