// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Rasterizes svg/ into out/: every PNG, .ico and .icns the apps, the site and the stores need.
// Run through ./build.sh, after emit.mjs. Needs sharp, which build.sh installs into .cache/.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUND } from './geometry.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sharp = createRequire(import.meta.url)(join(here, '.cache/node_modules/sharp'))
const out = join(here, 'out')
rmSync(out, { recursive: true, force: true })
const dir = (name) => { const p = join(out, name); mkdirSync(p, { recursive: true }); return p }
const svg = (name) => readFileSync(join(here, 'svg', name))

/** The natural size of an SVG, read from its width and height attributes. */
const natural = (buf) => {
  const head = buf.toString().slice(0, 400)
  return { w: Number(/ width="([\d.]+)"/.exec(head)[1]), h: Number(/ height="([\d.]+)"/.exec(head)[1]) }
}

/** Renders an SVG to a PNG buffer `width` px wide, rasterized at that size and not scaled from a larger one. */
async function render(name, width, { height, flatten } = {}) {
  const buf = svg(name)
  const n = natural(buf)
  const density = Math.max(72, Math.ceil((72 * width) / n.w))
  let img = sharp(buf, { density }).resize(width, height ?? Math.round((width * n.h) / n.w), { fit: 'fill' })
  if (flatten) img = img.flatten({ background: flatten }).removeAlpha()
  return img.png({ compressionLevel: 9 }).toBuffer()
}
const write = async (folder, file, name, width, opts) => writeFileSync(join(folder, file), await render(name, width, opts))

// ---------------------------------------------------------------- containers

function ico(frames) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(frames.length, 4)
  let offset = 6 + 16 * frames.length
  const entries = frames.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([head, ...entries, ...frames.map((f) => f.data)])
}

function icns(frames) {
  const parts = frames.map(({ type, data }) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'ascii')
    h.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([h, data])
  })
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

// ---------------------------------------------------------------- the mark

{
  const d = dir('png')
  for (const s of [64, 128, 256, 512]) await write(d, `slicerx-mark-${s}.png`, 'slicerx-mark.svg', s)
  for (const s of [256, 512]) await write(d, `slicerx-mark-light-${s}.png`, 'slicerx-mark-light.svg', s)
  await write(d, 'slicerx-mark-small-16.png', 'slicerx-mark-16.svg', 16)
  for (const s of [24, 32]) await write(d, `slicerx-mark-small-${s}.png`, 'slicerx-mark-small.svg', s)
  for (const s of [512, 1024]) await write(d, `slicerx-tile-${s}.png`, 'slicerx-tile.svg', s)
  await write(d, 'slicerx-tile-light-512.png', 'slicerx-tile-light.svg', 512)
  // The lockups, for a place that cannot take an SVG: twice the size they are shown at, most of the time.
  for (const [n, f] of [['dark', 'slicerx-lockup.svg'], ['light', 'slicerx-lockup-light.svg'], ['white', 'slicerx-lockup-white.svg'], ['ink', 'slicerx-lockup-ink.svg']])
    await write(d, `slicerx-lockup-${n}-720.png`, f, 720)
  await write(d, 'slicerx-lockup-stacked-720.png', 'slicerx-lockup-stacked.svg', 720)
  await write(d, 'slicerx-lockup-stacked-light-720.png', 'slicerx-lockup-stacked-light.svg', 720)
}

// ---------------------------------------------------------------- iOS and iPadOS

{
  const d = dir('ios')
  // The store rejects an icon with an alpha channel, so dark and light are flattened.
  await write(d, 'icon-dark-1024.png', 'slicerx-app-icon.svg', 1024, { flatten: '#17181f' })
  await write(d, 'icon-light-1024.png', 'slicerx-app-icon-light.svg', 1024, { flatten: '#e9eaf2' })
  await write(d, 'icon-tinted-1024.png', 'slicerx-app-icon-tinted.svg', 1024)
}

// ---------------------------------------------------------------- Android

{
  const d = dir('android')
  await write(d, 'adaptive-foreground-1024.png', 'slicerx-android-foreground.svg', 1024)
  await write(d, 'adaptive-background-1024.png', 'slicerx-android-background.svg', 1024)
  await write(d, 'adaptive-monochrome-1024.png', 'slicerx-android-monochrome.svg', 1024)
  // The Play Store listing icon: 512 px, full square, no alpha. Google rounds it.
  await write(d, 'play-store-512.png', 'slicerx-app-icon.svg', 512, { flatten: '#17181f' })
}

// ---------------------------------------------------------------- desktop

{
  const d = dir('desktop')
  const win = (s) => render(s === 16 ? 'slicerx-app-icon-16.svg' : s < 64 ? 'slicerx-app-icon-windows-small.svg' : 'slicerx-app-icon-windows.svg', s)
  // Tauri's icon set. The Linux and Windows sizes use the square tile, macOS uses the squircle.
  for (const [file, s] of [['32x32.png', 32], ['64x64.png', 64], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 512]])
    writeFileSync(join(d, file), await win(s))
  for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) writeFileSync(join(d, `Square${s}x${s}Logo.png`), await win(s))
  writeFileSync(join(d, 'StoreLogo.png'), await win(50))

  const winFrames = []
  for (const s of [16, 20, 24, 32, 40, 48, 64, 128, 256]) winFrames.push({ size: s, data: await win(s) })
  writeFileSync(join(d, 'icon.ico'), ico(winFrames))

  const mac = (s) => render(s === 16 ? 'slicerx-app-icon-16.svg' : s <= 64 ? 'slicerx-app-icon-macos-small.svg' : 'slicerx-app-icon-macos.svg', s)
  const frames = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ]
  const cache = new Map()
  const macFrames = []
  for (const [type, s] of frames) {
    if (!cache.has(s)) cache.set(s, await mac(s))
    macFrames.push({ type, data: cache.get(s) })
  }
  writeFileSync(join(d, 'icon.icns'), icns(macFrames))
  writeFileSync(join(d, 'macos-1024.png'), cache.get(1024))
}

// ---------------------------------------------------------------- browser and site

{
  const d = dir('favicon')
  copyFileSync(join(here, 'svg/slicerx-tab.svg'), join(d, 'icon.svg'))
  // Safari's .ico: the tile, so it keeps its own ground. 16 px is the four layer cut.
  const frames = [
    { size: 16, data: await render('slicerx-tab-tile-16.svg', 16) },
    { size: 32, data: await render('slicerx-tab-tile.svg', 32) },
    { size: 48, data: await render('slicerx-tab-tile.svg', 48) },
  ]
  writeFileSync(join(d, 'favicon.ico'), ico(frames))
  await write(d, 'apple-icon.png', 'slicerx-app-icon.svg', 180, { flatten: '#17181f' })
  // The manifest's icons: the tile for "any", and a full-bleed one for "maskable", whose X stays
  // inside the 80 percent safe circle.
  await write(d, 'icon-192.png', 'slicerx-tile.svg', 192)
  await write(d, 'icon-512.png', 'slicerx-tile.svg', 512)
  await write(d, 'icon-maskable-512.png', 'slicerx-app-icon.svg', 512, { flatten: '#17181f' })
}

// ---------------------------------------------------------------- social

{
  const d = dir('social')
  await write(d, 'slicerx-og-1200x630.png', 'slicerx-og.svg', 1200, { height: 630 })
  await write(d, 'slicerx-github-social-1280x640.png', 'slicerx-github-social.svg', 1280, { height: 640 })
  await write(d, 'slicerx-avatar-1024.png', 'slicerx-tile.svg', 1024)
  await write(d, 'slicerx-avatar-400.png', 'slicerx-tile.svg', 400)
  await write(d, 'slicerx-banner-dark-2560x720.png', 'slicerx-banner-dark.svg', 2560, { height: 720 })
  await write(d, 'slicerx-banner-light-2560x720.png', 'slicerx-banner-light.svg', 2560, { height: 720 })
}

// ---------------------------------------------------------------- splash

{
  const d = dir('splash')
  await write(d, 'splash-icon-1024.png', 'slicerx-splash.svg', 1024)
  await write(d, 'splash-icon-light-1024.png', 'slicerx-splash-light.svg', 1024)
}
console.log('rasters written to out/', GROUND.dark)
