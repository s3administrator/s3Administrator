import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { prisma } from "@/lib/db"
import { createFolderSchema } from "@/lib/validations"
import { PutObjectCommand } from "@aws-sdk/client-s3"

export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const parsed = createFolderSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid parameters", details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { bucket, key } = parsed.data
    const { client, credential } = await getS3Client(session.user.id)

    // Ensure key ends with /
    const folderKey = key.endsWith("/") ? key : `${key}/`

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: folderKey,
        Body: "",
      })
    )

    // Add FileMetadata entry for the folder
    await prisma.fileMetadata.upsert({
      where: {
        credentialId_bucket_key: {
          credentialId: credential.id,
          bucket,
          key: folderKey,
        },
      },
      create: {
        userId: session.user.id,
        credentialId: credential.id,
        bucket,
        key: folderKey,
        size: BigInt(0),
        lastModified: new Date(),
        isFolder: true,
      },
      update: {
        lastModified: new Date(),
      },
    })

    return NextResponse.json({ key: folderKey })
  } catch (error) {
    console.error("Failed to create folder:", error)
    const message = error instanceof Error ? error.message : "Failed to create folder"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
