import type { Metadata } from "next"
import { SeoLandingIndex } from "@/components/marketing/seo-landing-index"
import { buildMarketingMetadata } from "@/lib/seo"
import { getSeoLandingPagesByCategory } from "@/lib/seo-landing-pages"

export const metadata: Metadata = buildMarketingMetadata({
  title: "S3 Tool Comparisons",
  description:
    "Compare S3 Admin against default cloud dashboards and choose the right workflow for high-volume object operations.",
  path: "/compare",
})

export default function CompareIndexPage() {
  const pages = getSeoLandingPagesByCategory("compare")

  return <SeoLandingIndex category="compare" pages={pages} />
}
