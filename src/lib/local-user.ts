import { prisma } from "@/lib/db"

export const LOCAL_USER_ID = "local"

const LOCAL_USER = {
  id: LOCAL_USER_ID,
  name: "Local User",
  email: "local@localhost",
  role: "admin",
} as const

let ensured = false

export async function ensureLocalUser() {
  if (ensured) return
  await prisma.user.upsert({
    where: { id: LOCAL_USER.id },
    update: {},
    create: { ...LOCAL_USER },
  })
  ensured = true
}

export function getLocalUser() {
  return { ...LOCAL_USER }
}
