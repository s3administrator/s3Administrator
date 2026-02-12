import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Trash2, Zap, Lock, Github } from "lucide-react"
import { buildMarketingMetadata, SITE_NAME } from "@/lib/seo"
import { getSiteUrl } from "@/lib/site-url"

const GITHUB_REPO_URL = "https://github.com/tahayusufkomur/s3Administrator"

const faqItems = [
  {
    question: "What is S3 Admin used for?",
    answer:
      "S3 Admin is a self-hosted S3 file manager for browsing buckets, searching objects, running bulk operations, and recursive folder cleanup.",
  },
  {
    question: "Does S3 Admin work with non-AWS providers?",
    answer:
      "Yes. It works with AWS S3 and S3-compatible providers like Hetzner Object Storage and Cloudflare R2.",
  },
  {
    question: "Can teams use this instead of the default S3 console?",
    answer:
      "Yes. Many teams use S3 Admin for daily operational workflows and keep provider consoles for account-level settings.",
  },
  {
    question: "Is S3 Admin open source and self-hosted?",
    answer:
      "Yes. S3 Admin is open source and designed to run in your own infrastructure.",
  },
  {
    question: "Does S3 Admin support bulk delete and recursive delete?",
    answer:
      "Yes. Bulk and recursive delete workflows are core features.",
  },
]

export const metadata: Metadata = buildMarketingMetadata({
  title: "S3 File Manager for AWS, Hetzner & Cloudflare R2",
  description:
    "Open source S3 file manager with recursive delete, bulk operations, and secure credential handling for AWS and S3-compatible providers.",
  path: "/",
})

function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c")
}

export default function LandingPage() {
  const siteUrl = getSiteUrl()

  const softwareApplicationJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web Browser",
    description:
      "Open source S3 file manager with bulk operations, recursive delete, and multi-provider support.",
    url: siteUrl,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      category: "free",
    },
  }

  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: siteUrl,
    sameAs: [GITHUB_REPO_URL],
  }

  const websiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: siteUrl,
  }

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  }

  return (
    <div className="flex min-h-screen flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(softwareApplicationJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(organizationJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(websiteJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(faqJsonLd) }}
      />

      {/* Hero Section */}
      <section className="flex flex-1 items-center justify-center px-4 py-20 sm:py-32">
        <div className="w-full max-w-3xl space-y-8 text-center">
          {/* Tagline */}
          <div className="space-y-4">
            <div className="inline-block rounded-full bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
              ✨ Finally, S3 management that doesn&apos;t suck
            </div>

            <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">
              Manage your S3
              <br />
              <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                like a pro
              </span>
            </h1>

            <p className="mx-auto max-w-2xl text-xl leading-relaxed text-muted-foreground">
              S3 consoles are missing basic features. Delete folders recursively,
              bulk operations, search, sort, and move objects with one workflow.
              Works with AWS, Hetzner, Cloudflare R2, and any S3-compatible
              provider.
            </p>
          </div>

          {/* CTA Buttons */}
          <div className="flex flex-col justify-center gap-4 pt-4 sm:flex-row">
            <Button size="lg" asChild className="h-12 text-base">
              <Link href="/login">Get Started Free</Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="h-12 text-base">
              <a
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="mr-2 h-5 w-5" />
                View on GitHub
              </a>
            </Button>
          </div>

          {/* Trust Badge */}
          <p className="text-sm text-muted-foreground">
            🔐 Open source • Self-hosted • Credentials encrypted at rest
          </p>
        </div>
      </section>

      {/* Features Section */}
      <section className="bg-muted/40 px-4 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-12 text-center text-3xl font-bold">What you get</h2>

          <div className="grid gap-8 sm:grid-cols-3">
            {/* Feature 1 */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0">
                  <Trash2 className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-lg font-semibold">Recursive Delete</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Delete entire folders with one click. No more tedious file-by-file
                removal.
              </p>
            </div>

            {/* Feature 2 */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0">
                  <Zap className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-lg font-semibold">Bulk Operations</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Select multiple files. Delete, move, or download them all at once.
              </p>
            </div>

            {/* Feature 3 */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0">
                  <Lock className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-lg font-semibold">Fully Encrypted</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Credentials encrypted with AES-256. Even admins can&apos;t see your keys.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="px-4 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-12 text-center text-3xl font-bold">3 minutes to start</h2>

          <div className="grid gap-8 sm:grid-cols-3">
            <div className="space-y-3 text-center">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
                1
              </div>
              <div>
                <h3 className="font-semibold">Create account</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Email, GitHub, or Google
                </p>
              </div>
            </div>

            <div className="space-y-3 text-center">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
                2
              </div>
              <div>
                <h3 className="font-semibold">Add your credentials</h3>
                <p className="mt-1 text-sm text-muted-foreground">Access key & secret</p>
              </div>
            </div>

            <div className="space-y-3 text-center">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
                3
              </div>
              <div>
                <h3 className="font-semibold">Start managing</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Browse, upload, delete, move
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SEO Landing Hub */}
      <section className="border-y bg-muted/20 px-4 py-16">
        <div className="mx-auto max-w-4xl space-y-6">
          <h2 className="text-center text-3xl font-bold">Explore by use case</h2>
          <p className="text-center text-muted-foreground">
            Compare provider workflows and find the fastest path for your storage
            operations.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Link
              href="/features"
              className="rounded-lg border bg-card px-4 py-3 text-sm font-medium hover:border-primary hover:text-primary"
            >
              S3 feature guides
            </Link>
            <Link
              href="/providers"
              className="rounded-lg border bg-card px-4 py-3 text-sm font-medium hover:border-primary hover:text-primary"
            >
              Provider guides
            </Link>
            <Link
              href="/compare"
              className="rounded-lg border bg-card px-4 py-3 text-sm font-medium hover:border-primary hover:text-primary"
            >
              Tool comparisons
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-4 py-16">
        <div className="mx-auto max-w-4xl space-y-6">
          <h2 className="text-center text-3xl font-bold">Frequently asked questions</h2>
          <div className="space-y-3">
            {faqItems.map((item) => (
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
        </div>
      </section>

      {/* Footer CTA */}
      <section className="space-y-4 border-t px-4 py-12 text-center">
        <p className="text-muted-foreground">
          Ready to stop fighting with clunky S3 consoles?
        </p>
        <Button size="lg" asChild>
          <Link href="/login">Get Started Now</Link>
        </Button>
      </section>
    </div>
  )
}
