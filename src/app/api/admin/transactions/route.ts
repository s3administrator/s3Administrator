import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { stripe } from "@/lib/stripe"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import Stripe from "stripe"
import { z } from "zod/v4"

const createInvoiceSchema = z.object({
  email: z.string().trim().email().max(320),
  amountDollars: z.coerce.number().positive().max(1_000_000),
  description: z.string().trim().min(1).max(500),
  dueInDays: z.coerce.number().int().min(1).max(90).default(7),
})

type UserLookup = {
  id: string
  name: string | null
  email: string
  stripeCustomerId: string | null
}

function getCustomerId(invoice: Stripe.Invoice): string | null {
  const customer = invoice.customer
  if (!customer) return null
  return typeof customer === "string" ? customer : customer.id
}

function getCustomerEmail(invoice: Stripe.Invoice): string | null {
  if (invoice.customer_email) return invoice.customer_email

  const customer = invoice.customer
  if (!customer || typeof customer === "string" || ("deleted" in customer && customer.deleted)) {
    return null
  }

  return customer.email ?? null
}

function getCustomerName(invoice: Stripe.Invoice): string | null {
  const customer = invoice.customer
  if (!customer || typeof customer === "string" || ("deleted" in customer && customer.deleted)) {
    return null
  }

  return customer.name ?? null
}

function serializeInvoice(invoice: Stripe.Invoice, user: UserLookup | null) {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    collectionMethod: invoice.collection_method,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    amountRemaining: invoice.amount_remaining,
    subtotal: invoice.subtotal,
    total: invoice.total,
    createdAt: new Date(invoice.created * 1000).toISOString(),
    dueDate: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null,
    hostedInvoiceUrl: invoice.hosted_invoice_url,
    invoicePdf: invoice.invoice_pdf,
    customer: {
      id: getCustomerId(invoice),
      email: getCustomerEmail(invoice),
      name: getCustomerName(invoice),
    },
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
        }
      : null,
  }
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const { searchParams } = req.nextUrl
  const cursor = searchParams.get("cursor")
  const rawLimit = parseInt(searchParams.get("limit") ?? "20", 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 20

  const invoices = await stripe.invoices.list({
    limit,
    ...(cursor ? { starting_after: cursor } : {}),
    expand: ["data.customer"],
  })

  const customerIds = [...new Set(invoices.data.map(getCustomerId).filter((id): id is string => !!id))]
  const users = customerIds.length
    ? await prisma.user.findMany({
        where: { stripeCustomerId: { in: customerIds } },
        select: {
          id: true,
          name: true,
          email: true,
          stripeCustomerId: true,
        },
      })
    : []

  const usersByCustomerId = new Map(users.map((user) => [user.stripeCustomerId, user]))
  const transactions = invoices.data.map((invoice) => {
    const customerId = getCustomerId(invoice)
    const user = customerId ? usersByCustomerId.get(customerId) ?? null : null
    return serializeInvoice(invoice, user)
  })

  return NextResponse.json({
    transactions,
    hasMore: invoices.has_more,
    nextCursor: invoices.data.at(-1)?.id ?? null,
  })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const rl = rateLimitByUser(session.user.id, "admin", 30)
  if (!rl.success) return rateLimitResponse(rl.retryAfterSeconds)

  const body = await req.json()
  const parsed = createInvoiceSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 })
  }

  const amountCents = Math.round(parsed.data.amountDollars * 100)
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: "Amount must be greater than zero" }, { status: 400 })
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: parsed.data.email, mode: "insensitive" } },
    select: { id: true, name: true, email: true, stripeCustomerId: true },
  })

  let customerId = user?.stripeCustomerId ?? null

  if (!customerId) {
    const existingCustomer = await stripe.customers.list({
      email: parsed.data.email,
      limit: 1,
    })

    customerId = existingCustomer.data[0]?.id ?? null

    if (!customerId) {
      const createdCustomer = await stripe.customers.create({
        email: parsed.data.email,
        metadata: {
          ...(user ? { userId: user.id } : {}),
          createdByAdminId: session.user.id,
        },
      })
      customerId = createdCustomer.id
    }

    if (user && !user.stripeCustomerId) {
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      })
    }
  }

  try {
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: amountCents,
      currency: "usd",
      description: parsed.data.description,
    })

    const draftInvoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: parsed.data.dueInDays,
      auto_advance: false,
      metadata: {
        ...(user ? { userId: user.id } : {}),
        createdByAdminId: session.user.id,
      },
    })

    const finalizedInvoice =
      draftInvoice.status === "draft"
        ? await stripe.invoices.finalizeInvoice(draftInvoice.id)
        : draftInvoice

    const sentInvoice = await stripe.invoices.sendInvoice(finalizedInvoice.id)

    return NextResponse.json(
      {
        invoice: {
          id: sentInvoice.id,
          number: sentInvoice.number,
          status: sentInvoice.status,
          currency: sentInvoice.currency,
          amountDue: sentInvoice.amount_due,
          hostedInvoiceUrl: sentInvoice.hosted_invoice_url,
          customerEmail: parsed.data.email,
        },
      },
      { status: 201 }
    )
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json({ error: error.message || "Failed to send invoice" }, { status: 400 })
    }
    throw error
  }
}
