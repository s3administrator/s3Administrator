import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getS3Client } from "@/lib/s3"
import { rateLimitByUser, rateLimitResponse } from "@/lib/rate-limit"
import { ListBucketsCommand } from "@aws-sdk/client-s3"

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get("id")
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 })
  }

  try {
    const { client } = await getS3Client(session.user.id, id)
    await client.send(new ListBucketsCommand({}))
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: "Connection failed" }, { status: 400 })
  }
}
