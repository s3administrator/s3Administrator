import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { getS3Client } from "@/lib/s3"
import { ListBucketsCommand } from "@aws-sdk/client-s3"

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = request.nextUrl
    const all = searchParams.get("all") === "true"
    const credentialId = searchParams.get("credentialId")

    // If requesting a specific credential or just default, use single credential
    if (credentialId || !all) {
      const { client } = await getS3Client(session.user.id, credentialId || undefined)
      const response = await client.send(new ListBucketsCommand({}))

      const buckets = (response.Buckets ?? []).map((b) => ({
        name: b.Name ?? "",
        creationDate: b.CreationDate?.toISOString() ?? null,
        credentialId: credentialId || "default",
      }))

      return NextResponse.json({ buckets })
    }

    // Fetch buckets from all credentials
    const credentials = await prisma.s3Credential.findMany({
      where: { userId: session.user.id },
      select: { id: true },
    })

    const allBuckets: Array<{
      name: string
      creationDate: string | null
      credentialId: string
    }> = []
    const bucketSet = new Set<string>()

    for (const cred of credentials) {
      try {
        const { client } = await getS3Client(session.user.id, cred.id)
        const response = await client.send(new ListBucketsCommand({}))

        for (const b of response.Buckets ?? []) {
          const bucketName = b.Name ?? ""
          // Add bucket only from first credential that has it (avoid duplicates)
          if (!bucketSet.has(bucketName)) {
            bucketSet.add(bucketName)
            allBuckets.push({
              name: bucketName,
              creationDate: b.CreationDate?.toISOString() ?? null,
              credentialId: cred.id,
            })
          }
        }
      } catch (error) {
        console.warn(`Failed to list buckets for credential ${cred.id}:`, error)
      }
    }

    return NextResponse.json({ buckets: allBuckets })
  } catch (error) {
    console.error("Failed to list buckets:", error)
    const message = error instanceof Error ? error.message : "Failed to list buckets"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
