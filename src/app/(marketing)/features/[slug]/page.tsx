import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { SeoLandingPage } from "@/components/marketing/seo-landing-page"
import { buildMarketingMetadata } from "@/lib/seo"
import {
  getSeoLandingPage,
  getSeoLandingPagesByCategory,
} from "@/lib/seo-landing-pages"

type PageProps = {
  params: Promise<{ slug: string }>
}

export function generateStaticParams() {
  return getSeoLandingPagesByCategory("features").map((page) => ({
    slug: page.slug,
  }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = getSeoLandingPage("features", slug)

  if (!page) {
    return {}
  }

  return buildMarketingMetadata({
    title: page.title,
    description: page.description,
    path: `/features/${page.slug}`,
  })
}

export default async function FeatureLandingPage({ params }: PageProps) {
  const { slug } = await params
  const page = getSeoLandingPage("features", slug)

  if (!page) {
    notFound()
  }

  return <SeoLandingPage page={page} />
}
