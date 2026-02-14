export type Environment = "COMMUNITY" | "CLOUD"

/**
 * Returns the current environment: "COMMUNITY" or "CLOUD".
 * Throws when ENVIRONMENT is missing or invalid.
 */
export function getEnvironment(): Environment {
  const env = process.env.ENVIRONMENT?.trim().toUpperCase()
  if (env === "COMMUNITY" || env === "CLOUD") return env
  throw new Error('ENVIRONMENT must be set to either "COMMUNITY" or "CLOUD".')
}

/**
 * Resolves an environment variable with _COMMUNITY/_CLOUD suffix support.
 *
 * Lookup order:
 *   1. `KEY_COMMUNITY` or `KEY_CLOUD` (based on current ENVIRONMENT)
 *   2. `KEY` (unsuffixed fallback)
 */
export function envVar(key: string): string {
  const suffix = getEnvironment()
  return process.env[`${key}_${suffix}`] || process.env[key] || ""
}
