import Link from "next/link"
import type {
  SeoLandingCategory,
  SeoLandingPageConfig,
} from "@/lib/seo-landing-pages"

const categoryTitles: Record<SeoLandingCategory, string> = {
  features: "S3 Feature Guides",
  providers: "Provider-Specific S3 Guides",
  compare: "S3 Comparison Guides",
}

const categoryDescriptions: Record<SeoLandingCategory, string> = {
  features:
    "Deep dives into high-impact S3 workflows like bulk delete, recursive cleanup, and file-manager style operations.",
  providers:
    "Practical setup and workflow guidance for AWS S3, Hetzner Object Storage, and Cloudflare R2.",
  compare:
    "Side-by-side comparisons to help teams choose the right S3 management workflow and tooling.",
}

export function SeoLandingIndex({
  category,
  pages,
}: {
  category: SeoLandingCategory
  pages: SeoLandingPageConfig[]
}) {
  return (
    <section className="mx-auto max-w-5xl space-y-10 px-4 py-20">
      <header className="space-y-3">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          {categoryTitles[category]}
        </h1>
        <p className="max-w-3xl text-lg text-muted-foreground">
          {categoryDescriptions[category]}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {pages.map((page) => (
          <Link
            key={page.slug}
            href={`/${page.category}/${page.slug}`}
            className="rounded-xl border bg-card p-5 hover:border-primary"
          >
            <h2 className="text-xl font-semibold">{page.title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {page.description}
            </p>
          </Link>
        ))}
      </div>
    </section>
  )
}
