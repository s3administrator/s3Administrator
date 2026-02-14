import Link from "next/link"
import { CheckCircle2 } from "lucide-react"
import type { SeoLandingPageConfig } from "@/lib/seo-landing-pages"
import { absoluteUrl } from "@/lib/site-url"
import { Button } from "@/components/ui/button"

function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c")
}

export function SeoLandingPage({ page }: { page: SeoLandingPageConfig }) {
  const pagePath = `/${page.category}/${page.slug}`
  const pageUrl = absoluteUrl(pagePath)

  const webPageJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: page.title,
    description: page.description,
    url: pageUrl,
    keywords: page.keywords.join(", "),
  }

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: page.faq.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  }

  return (
    <article className="mx-auto max-w-5xl space-y-16 px-4 py-20">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(webPageJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(faqJsonLd) }}
      />

      <header className="space-y-6">
        <p className="text-sm font-medium uppercase tracking-wider text-primary">
          {page.category}
        </p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{page.h1}</h1>
        <p className="max-w-3xl text-lg text-muted-foreground">{page.intro}</p>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/pricing">See Pricing</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/login">Start Free</Link>
          </Button>
        </div>
      </header>

      <section className="grid gap-8 md:grid-cols-2">
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-xl font-semibold">Common pain points</h2>
          <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
            {page.problemPoints.map((point) => (
              <li key={point} className="flex items-start gap-2">
                <span className="mt-1 inline-flex h-2 w-2 rounded-full bg-primary" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-xl font-semibold">How S3 Administrator helps</h2>
          <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
            {page.solutionPoints.map((point) => (
              <li key={point} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="rounded-xl border bg-muted/20 p-6">
        <h2 className="text-2xl font-semibold">Why teams switch</h2>
        <ul className="mt-4 grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
          {page.proofPoints.map((point) => (
            <li key={point} className="rounded-lg border bg-card px-4 py-3">
              {point}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">Related guides</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {page.relatedLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg border bg-card px-4 py-3 text-sm font-medium hover:border-primary hover:text-primary"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">FAQ</h2>
        <div className="space-y-3">
          {page.faq.map((item) => (
            <details
              key={item.question}
              className="rounded-lg border bg-card px-4 py-3"
            >
              <summary className="cursor-pointer font-medium">
                {item.question}
              </summary>
              <p className="mt-2 text-sm text-muted-foreground">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>
    </article>
  )
}
