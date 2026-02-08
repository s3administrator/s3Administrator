/**
 * Returns the current environment: "DEV" or "PROD".
 * Falls back to "DEV" when not set or when NODE_ENV is "development".
 */
export function getEnvironment(): "DEV" | "PROD" {
  const env = process.env.ENVIRONMENT?.toUpperCase()
  if (env === "PROD") return "PROD"
  return "DEV"
}

/**
 * Resolves an environment variable with _DEV/_PROD suffix support.
 *
 * Lookup order:
 *   1. `KEY_DEV` or `KEY_PROD` (based on current ENVIRONMENT)
 *   2. `KEY` (unsuffixed fallback)
 *
 * This lets you put both dev and prod values in a single .env and
 * switch between them with `ENVIRONMENT=DEV|PROD`.
 */
export function envVar(key: string): string {
  const suffix = getEnvironment()
  return process.env[`${key}_${suffix}`] || process.env[key] || ""
}
