import { NextRequest, NextResponse } from "next/server"
import { communityGuard } from "@/lib/api-guard";
import { auth } from "@/lib/auth"
import { stripe } from "@/lib/stripe"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import Stripe from "stripe"

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const _guard = communityGuard(); if (_guard) return _guard;
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { id } = await params

  try {
    const invoice = await stripe.invoices.retrieve(id)

    if (invoice.collection_method !== "send_invoice") {
      return NextResponse.json(
        { error: "Only manual invoices can be sent from admin." },
        { status: 400 }
      )
    }

    if (invoice.status === "paid" || invoice.status === "void" || invoice.status === "uncollectible") {
      return NextResponse.json(
        { error: `Invoice cannot be sent in '${invoice.status}' status.` },
        { status: 400 }
      )
    }

    const finalizedInvoice =
      invoice.status === "draft" ? await stripe.invoices.finalizeInvoice(invoice.id) : invoice

    const sentInvoice = await stripe.invoices.sendInvoice(finalizedInvoice.id)

    return NextResponse.json({
      invoice: {
        id: sentInvoice.id,
        number: sentInvoice.number,
        status: sentInvoice.status,
        hostedInvoiceUrl: sentInvoice.hosted_invoice_url,
      },
    })
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json({ error: error.message || "Failed to send invoice" }, { status: 400 })
    }
    throw error
  }
}
