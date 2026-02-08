import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { ListBucketsCommand } from "@aws-sdk/client-s3"

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { client } = await getS3Client(session.user.id)
    const response = await client.send(new ListBucketsCommand({}))

    const buckets = (response.Buckets ?? []).map((b) => ({
      name: b.Name ?? "",
      creationDate: b.CreationDate?.toISOString() ?? null,
    }))

    return NextResponse.json({ buckets })
  } catch (error) {
    console.error("Failed to list buckets:", error)
    const message = error instanceof Error ? error.message : "Failed to list buckets"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
