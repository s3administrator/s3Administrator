import type { MetadataRoute } from "next"
import { getSiteUrl, absoluteUrl } from "@/lib/site-url"

const PRIVATE_PATHS = [
  "/admin/",
  "/dashboard/",
  "/settings/",
  "/billing/",
  "/api/",
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: PRIVATE_PATHS,
      },
      {
        userAgent: "OAI-SearchBot",
        allow: "/",
        disallow: PRIVATE_PATHS,
      },
      {
        userAgent: "ChatGPT-User",
        allow: "/",
        disallow: PRIVATE_PATHS,
      },
      {
        userAgent: "GPTBot",
        disallow: "/",
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: getSiteUrl(),
  }
}
