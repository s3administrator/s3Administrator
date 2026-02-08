import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Check } from "lucide-react"
import { prisma } from "@/lib/db"
import { SubscribeButton } from "@/components/pricing/subscribe-button"

function formatPrice(cents: number): string {
  if (cents === 0) return "$0"
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

function formatLimit(n: number): string {
  if (n === 0) return "Unlimited"
  return n.toLocaleString()
}

function isContactPlan(plan: { priceMonthly: number; stripePriceId: string | null; slug: string }): boolean {
  return plan.priceMonthly === 0 && !plan.stripePriceId && plan.slug !== "free"
}

export default async function PricingPage() {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      priceMonthly: true,
      bucketLimit: true,
      fileLimit: true,
      features: true,
      stripePriceId: true,
    },
  })

  // Find which plan to mark as popular (highest priced plan with a stripe price)
  const popularSlug = plans
    .filter((p) => p.stripePriceId)
    .sort((a, b) => b.priceMonthly - a.priceMonthly)[0]?.slug

  return (
    <section className="mx-auto max-w-6xl px-4 py-24">
      <div className="text-center">
        <h1 className="text-3xl font-bold">Simple pricing</h1>
        <p className="mt-2 text-muted-foreground">
          Start free, upgrade when you need more.
        </p>
      </div>
      <div
        className="mt-12 grid gap-8 sm:grid-cols-2"
        style={{
          gridTemplateColumns: `repeat(${Math.min(plans.length, 4)}, minmax(0, 1fr))`,
        }}
      >
        {plans.map((plan) => {
          const popular = plan.slug === popularSlug
          const contact = isContactPlan(plan)

          return (
            <Card
              key={plan.id}
              className={`flex flex-col ${popular ? "border-primary shadow-md" : ""}`}
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{plan.name}</CardTitle>
                  {popular && <Badge>Popular</Badge>}
                </div>
                <div className="mt-2">
                  <span className="text-3xl font-bold">
                    {contact ? "Custom" : plan.priceMonthly === 0 ? "Free" : formatPrice(plan.priceMonthly)}
                  </span>
                  {plan.priceMonthly > 0 && (
                    <span className="text-muted-foreground">/month</span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col space-y-4">
                <ul className="space-y-2">
                  <li className="flex items-center gap-2 text-sm">
                    <Check className="h-4 w-4 text-primary" />
                    {formatLimit(plan.bucketLimit)} bucket{plan.bucketLimit !== 1 ? "s" : ""}
                  </li>
                  <li className="flex items-center gap-2 text-sm">
                    <Check className="h-4 w-4 text-primary" />
                    {formatLimit(plan.fileLimit)} cached files
                  </li>
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2 text-sm">
                      <Check className="h-4 w-4 text-primary" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto">
                  {contact ? (
                    <Button className="w-full" variant="outline" asChild>
                      <a href="mailto:hello@s3administrator.com">Contact Us</a>
                    </Button>
                  ) : plan.stripePriceId ? (
                    <SubscribeButton
                      planId={plan.id}
                      label="Get Started"
                      popular={popular}
                    />
                  ) : (
                    <Button
                      className="w-full"
                      variant="outline"
                      asChild
                    >
                      <Link href="/login">Get Started</Link>
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </section>
  )
}
