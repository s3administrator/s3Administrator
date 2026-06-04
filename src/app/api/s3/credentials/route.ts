import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { rebuildUserExtensionStats } from "@/lib/file-stats"
import { encrypt } from "@/lib/crypto"
import { normalizeS3Endpoint, normalizeS3Region } from "@/lib/s3"
import { addCredentialSchema } from "@/lib/validations"

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
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { label, provider, endpoint, region, accessKey, secretKey } = parsed.data
  let normalizedEndpoint: string
  let normalizedRegion: string
  try {
    normalizedEndpoint = normalizeS3Endpoint(endpoint)
    normalizedRegion = normalizeS3Region(provider, region)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid S3 credential settings"
    return NextResponse.json({ error: message }, { status: 400 })
  }

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
      endpoint: normalizedEndpoint,
      region: normalizedRegion,
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
