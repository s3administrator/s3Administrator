// Desktop build: edition split is gone. These constants exist only so legacy
// callers compile. Treat as if everything runs in "community" (single-user) mode.

export function isCommunityEdition(): boolean {
  return true
}

export function isCloudEdition(): boolean {
  return false
}
