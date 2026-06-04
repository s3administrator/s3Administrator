import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await req.json()
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 })
  }

  await prisma.$transaction([
    prisma.s3Credential.updateMany({
      where: { userId: session.user.id },
      data: { isDefault: false },
    }),
    prisma.s3Credential.update({
      where: { id, userId: session.user.id },
      data: { isDefault: true },
    }),
  ])

  return NextResponse.json({ ok: true })
}
