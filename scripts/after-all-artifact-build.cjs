/**
 * electron-builder afterAllArtifactBuild hook.
 *
 * electron-builder notarizes + staples the .app (so the *app* validates
 * offline), but it does NOT notarize the .dmg container. A freshly downloaded,
 * unnotarized .dmg gets rejected by Gatekeeper on mount ("Apple cannot check it
 * for malicious software"). Here we notarize + staple each produced .dmg so the
 * download is clean end-to-end.
 *
 * Runs only when Apple credentials are present in the environment (i.e. a
 * `dist:notarized` build); unsigned builds skip it.
 */
const { execFileSync } = require("node:child_process")
const { existsSync } = require("node:fs")

exports.default = async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== "darwin") return []

  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith(".dmg"))
  if (dmgs.length === 0) return []

  const env = process.env
  const hasPassword = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID
  const hasApiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER
  if (!hasPassword && !hasApiKey) {
    console.log("  • afterAllArtifactBuild: no Apple credentials in env — skipping DMG notarization")
    return []
  }

  const creds = hasPassword
    ? ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID]
    : ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER]

  for (const dmg of dmgs) {
    if (!existsSync(dmg)) continue
    console.log(`  • notarizing DMG: ${dmg}`)
    execFileSync("xcrun", ["notarytool", "submit", dmg, ...creds, "--wait"], { stdio: "inherit" })
    console.log(`  • stapling DMG: ${dmg}`)
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" })
  }
  return []
}
