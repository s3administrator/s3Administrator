/**
 * electron-builder afterPack hook.
 *
 * electron-builder refuses to copy a `node_modules` directory verbatim — even
 * via extraResources it strips the standalone's top-level node_modules, which
 * breaks the generated .prisma/client and leaves the .next/node_modules hashed
 * symlinks dangling (codesign then fails on the broken links).
 *
 * So we copy the self-contained .next/standalone bundle into the packed app
 * ourselves, here — after packaging, before code signing — with a plain
 * recursive copy that preserves the symlinks and their targets intact.
 */
const path = require("node:path")
const { existsSync, rmSync, cpSync } = require("node:fs")

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return

  const projectDir = context.packager.info.projectDir || process.cwd()
  const src = path.join(projectDir, ".next", "standalone")
  if (!existsSync(src)) {
    throw new Error(`afterPack: ${src} not found — run \`npm run build:desktop\` before packaging`)
  }

  const appName = context.packager.appInfo.productFilename
  const dest = path.join(
    context.appOutDir,
    `${appName}.app`,
    "Contents",
    "Resources",
    "app",
    ".next",
    "standalone"
  )

  rmSync(dest, { recursive: true, force: true })
  // verbatimSymlinks keeps the relative link text (e.g. ../../node_modules/shiki)
  // instead of resolving it to an absolute source path. Absolute symlinks make
  // codesign reject the bundle ("invalid destination for symbolic link"); the
  // relative ones resolve correctly inside the copied tree.
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true })
  console.log(`  • afterPack: copied .next/standalone bundle into ${path.relative(projectDir, dest)}`)
}
