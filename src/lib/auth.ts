import { LOCAL_USER_ID, ensureLocalUser, getLocalUser } from "@/lib/local-user"

type LocalSession = {
  user: { id: string; role: string; name: string; email: string }
  expires: string
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

let cachedSession: Promise<LocalSession> | null = null

function buildSession(): Promise<LocalSession> {
  if (!cachedSession) {
    cachedSession = (async () => {
      await ensureLocalUser()
      const user = getLocalUser()
      return {
        user: { id: user.id, role: user.role, name: user.name, email: user.email },
        expires: new Date(Date.now() + ONE_YEAR_MS).toISOString(),
      }
    })()
  }
  return cachedSession
}

export async function auth(): Promise<LocalSession> {
  return buildSession()
}

export const LOCAL_SESSION_USER_ID = LOCAL_USER_ID
