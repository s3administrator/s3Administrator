import type { Metadata } from "next"
import { SeoLandingIndex } from "@/components/marketing/seo-landing-index"
import { buildMarketingMetadata } from "@/lib/seo"
import { getSeoLandingPagesByCategory } from "@/lib/seo-landing-pages"

export const metadata: Metadata = buildMarketingMetadata({
  title: "S3 Feature Guides",
  description:
    "Guides for S3 bulk operations, recursive delete workflows, and file-manager style storage operations.",
  path: "/features",
})

export default function FeaturesIndexPage() {
  const pages = getSeoLandingPagesByCategory("features")

  return <SeoLandingIndex category="features" pages={pages} />
}
