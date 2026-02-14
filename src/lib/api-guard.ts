import { NextResponse } from "next/server"
import { isCommunityEdition } from "@/lib/edition"

export function communityGuard() {
  if (isCommunityEdition()) {
    return NextResponse.json(
      { error: "This feature is not available in the community edition" },
      { status: 404 }
    )
  }
  return null
}
