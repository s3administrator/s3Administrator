import type { MetadataRoute } from "next"
import { seoLandingPages } from "@/lib/seo-landing-pages"
import { absoluteUrl } from "@/lib/site-url"

const STATIC_MARKETING_PATHS = [
  "/",
  "/pricing",
  "/features",
  "/providers",
  "/compare",
] as const

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()

  const staticPages: MetadataRoute.Sitemap = STATIC_MARKETING_PATHS.map((path) => ({
    url: absoluteUrl(path),
    lastModified,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.8,
  }))

  const landingPages: MetadataRoute.Sitemap = seoLandingPages.map((page) => ({
    url: absoluteUrl(`/${page.category}/${page.slug}`),
    lastModified,
    changeFrequency: "weekly",
    priority: 0.7,
  }))

  return [...staticPages, ...landingPages]
}
