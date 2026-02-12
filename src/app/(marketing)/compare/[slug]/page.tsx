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
  return getSeoLandingPagesByCategory("compare").map((page) => ({
    slug: page.slug,
  }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = getSeoLandingPage("compare", slug)

  if (!page) {
    return {}
  }

  return buildMarketingMetadata({
    title: page.title,
    description: page.description,
    path: `/compare/${page.slug}`,
  })
}

export default async function CompareLandingPage({ params }: PageProps) {
  const { slug } = await params
  const page = getSeoLandingPage("compare", slug)

  if (!page) {
    notFound()
  }

  return <SeoLandingPage page={page} />
}
