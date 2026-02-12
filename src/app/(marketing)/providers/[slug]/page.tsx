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
  return getSeoLandingPagesByCategory("providers").map((page) => ({
    slug: page.slug,
  }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = getSeoLandingPage("providers", slug)

  if (!page) {
    return {}
  }

  return buildMarketingMetadata({
    title: page.title,
    description: page.description,
    path: `/providers/${page.slug}`,
  })
}

export default async function ProviderLandingPage({ params }: PageProps) {
  const { slug } = await params
  const page = getSeoLandingPage("providers", slug)

  if (!page) {
    notFound()
  }

  return <SeoLandingPage page={page} />
}
