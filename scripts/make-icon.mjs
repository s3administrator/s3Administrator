#!/usr/bin/env node
/**
 * Rasterize build/icon-source.svg (the bucket mark) into a 1024×1024
 * build/icon.png that electron-builder turns into the .icns app icon.
 *
 * The mark is rendered at 824px and centered on a transparent 1024 canvas so
 * it sits inside the macOS icon safe-area instead of bleeding to the edge.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const buildDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "build")
const svg = readFileSync(join(buildDir, "icon-source.svg"))

const CANVAS = 1024
const MARK = 824
const pad = Math.round((CANVAS - MARK) / 2)

const mark = await sharp(svg, { density: 384 })
  .resize(MARK, MARK, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer()

const out = await sharp({
  create: {
    width: CANVAS,
    height: CANVAS,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([{ input: mark, top: pad, left: pad }])
  .png()
  .toBuffer()

writeFileSync(join(buildDir, "icon.png"), out)
console.log(`✓ wrote build/icon.png (${CANVAS}×${CANVAS})`)
