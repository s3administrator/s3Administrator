import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { z } from "zod/v4"

const updateUserSchema = z.object({
  tier: z.enum(["free", "pro", "team"]).optional(),
  role: z.enum(["user", "admin"]).optional(),
})

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params
  const body = await req.json()
  const parsed = updateUserSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 })
  }

  const updated = await prisma.user.update({
    where: { id },
    data: parsed.data,
    select: { id: true, tier: true, role: true },
  })

  return NextResponse.json(updated)
}
