export type Edition = "community" | "cloud"

export function getEdition(): Edition {
  const val = (process.env.NEXT_PUBLIC_EDITION || process.env.EDITION || "").trim().toLowerCase()
  if (val === "cloud") return "cloud"
  return "community"
}

export function isCloudEdition(): boolean {
  return getEdition() === "cloud"
}

export function isCommunityEdition(): boolean {
  return getEdition() !== "cloud"
}
