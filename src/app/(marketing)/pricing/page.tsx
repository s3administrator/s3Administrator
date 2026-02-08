import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Check } from "lucide-react"

const plans = [
  {
    name: "Free",
    price: "$0",
    description: "For trying it out",
    features: ["1 bucket", "1,000 cached files", "All file operations", "Metadata caching"],
    cta: "Get Started",
    href: "/login",
    popular: false,
  },
  {
    name: "Starter",
    price: "$3",
    description: "For individual developers",
    features: [
      "10 buckets",
      "10,000 cached files",
      "All file operations",
      "Metadata caching",
      "Priority support",
    ],
    cta: "Upgrade to Starter",
    href: "/login",
    popular: false,
  },
  {
    name: "Pro",
    price: "$9",
    description: "For power users",
    features: [
      "Unlimited buckets",
      "100,000 cached files",
      "All file operations",
      "Metadata caching",
      "Priority support",
    ],
    cta: "Upgrade to Pro",
    href: "/login",
    popular: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    description: "For teams and organizations",
    features: [
      "Unlimited buckets",
      "Unlimited cached files",
      "All file operations",
      "Metadata caching",
      "Priority support",
      "Dedicated support",
    ],
    cta: "Contact Us",
    href: "mailto:hello@s3administrator.com",
    popular: false,
  },
]

export default function PricingPage() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-24">
      <div className="text-center">
        <h1 className="text-3xl font-bold">Simple pricing</h1>
        <p className="mt-2 text-muted-foreground">
          Start free, upgrade when you need more.
        </p>
      </div>
      <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => (
          <Card
            key={plan.name}
            className={plan.popular ? "border-primary shadow-md" : ""}
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{plan.name}</CardTitle>
                {plan.popular && <Badge>Popular</Badge>}
              </div>
              <div className="mt-2">
                <span className="text-3xl font-bold">{plan.price}</span>
                {plan.price !== "Custom" && (
                  <span className="text-muted-foreground">/month</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {plan.description}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-sm">
                    <Check className="h-4 w-4 text-primary" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button
                className="w-full"
                variant={plan.popular ? "default" : "outline"}
                asChild
              >
                <Link href={plan.href}>{plan.cta}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}
