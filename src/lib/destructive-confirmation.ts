export type DestructiveConfirmRememberOption = "ask" | "one_hour"

export const DESTRUCTIVE_CONFIRM_PHRASE = "I confirm"
export const DESTRUCTIVE_CONFIRM_SCOPE = "all-destructive-actions"

const STORAGE_KEY = "s3admin:destructive-confirm-bypass:v1"
const ONE_HOUR_MS = 60 * 60 * 1000

type BypassState = Record<string, number>

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null
  return window.localStorage
}

function normalizeBypassState(value: unknown): BypassState {
  if (!value || typeof value !== "object") {
    return {}
  }

  const now = Date.now()
  const entries = Object.entries(value as Record<string, unknown>)
  const result: BypassState = {}

  for (const [scope, expiresAt] of entries) {
    if (typeof expiresAt !== "number") continue
    if (!Number.isFinite(expiresAt)) continue
    if (expiresAt <= now) continue
    result[scope] = expiresAt
  }

  return result
}

function readBypassState(storage: Storage): BypassState {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return normalizeBypassState(JSON.parse(raw))
  } catch {
    return {}
  }
}

function writeBypassState(storage: Storage, state: BypassState) {
  try {
    if (Object.keys(state).length === 0) {
      storage.removeItem(STORAGE_KEY)
      return
    }

    storage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage quota and browser privacy errors.
  }
}

export function hasDestructiveConfirmBypass(scope = DESTRUCTIVE_CONFIRM_SCOPE): boolean {
  const storage = getStorage()
  if (!storage) return false

  const state = readBypassState(storage)
  const expiresAt = state[scope]
  const active = typeof expiresAt === "number" && expiresAt > Date.now()

  if (!active && scope in state) {
    delete state[scope]
    writeBypassState(storage, state)
  }

  return active
}

export function setDestructiveConfirmBypass(
  scope: string,
  rememberOption: DestructiveConfirmRememberOption
) {
  const storage = getStorage()
  if (!storage) return

  const state = readBypassState(storage)

  if (rememberOption === "one_hour") {
    state[scope] = Date.now() + ONE_HOUR_MS
  } else {
    delete state[scope]
  }

  writeBypassState(storage, state)
}
