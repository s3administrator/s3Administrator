import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { rebuildUserExtensionStats } from "@/lib/file-stats"
import { encrypt } from "@/lib/crypto"
import { addCredentialSchema } from "@/lib/validations"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const credentials = await prisma.s3Credential.findMany({
    where: { userId: session.user.id },
    select: {
      id: true,
      label: true,
      provider: true,
      endpoint: true,
      region: true,
      isDefault: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  })

  return NextResponse.json(credentials)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json()
  const parsed = addCredentialSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 })
  }

  const { label, provider, endpoint, region, accessKey, secretKey } = parsed.data

  const encAccessKey = encrypt(accessKey)
  const encSecretKey = encrypt(secretKey)

  const existingCount = await prisma.s3Credential.count({
    where: { userId: session.user.id },
  })

  const credential = await prisma.s3Credential.create({
    data: {
      userId: session.user.id,
      label,
      provider,
      endpoint,
      region,
      accessKeyEnc: encAccessKey.ciphertext,
      ivAccessKey: encAccessKey.iv,
      secretKeyEnc: encSecretKey.ciphertext,
      ivSecretKey: encSecretKey.iv,
      isDefault: existingCount === 0,
    },
  })

  return NextResponse.json({ id: credential.id })
}

export async function DELETE(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 })
  }

  await prisma.s3Credential.deleteMany({
    where: { id, userId: session.user.id },
  })

  await rebuildUserExtensionStats(session.user.id)

  return NextResponse.json({ deleted: true })
}
