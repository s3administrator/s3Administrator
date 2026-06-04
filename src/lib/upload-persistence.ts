const STORAGE_KEY = "s3admin:upload-state:v1"
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface PersistedUploadState {
  uploadId: string
  bucket: string
  key: string
  credentialId?: string
  fileName: string
  fileSize: number
  fileLastModified: number
  chunkSize: number
  totalParts: number
  completedPartNumbers: number[]
  createdAt: number
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null
  return window.localStorage
}

function readAll(storage: Storage): PersistedUploadState[] {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as PersistedUploadState[]
  } catch {
    return []
  }
}

function writeAll(storage: Storage, uploads: PersistedUploadState[]) {
  try {
    if (uploads.length === 0) {
      storage.removeItem(STORAGE_KEY)
      return
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(uploads))
  } catch {
    // Ignore storage quota and browser privacy errors
  }
}

export function saveUploadState(state: PersistedUploadState): void {
  const storage = getStorage()
  if (!storage) return

  const all = readAll(storage)
  const idx = all.findIndex((u) => u.uploadId === state.uploadId)
  if (idx >= 0) {
    all[idx] = state
  } else {
    all.push(state)
  }
  writeAll(storage, all)
}

export function removeUploadState(uploadId: string): void {
  const storage = getStorage()
  if (!storage) return

  const all = readAll(storage)
  writeAll(
    storage,
    all.filter((u) => u.uploadId !== uploadId)
  )
}

export function getPersistedUploads(): PersistedUploadState[] {
  const storage = getStorage()
  if (!storage) return []

  const now = Date.now()
  const all = readAll(storage)
  const valid = all.filter((u) => now - u.createdAt < MAX_AGE_MS)

  // Clean up expired entries
  if (valid.length !== all.length) {
    writeAll(storage, valid)
  }

  return valid
}
