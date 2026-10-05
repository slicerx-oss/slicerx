// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes every SVG in svg/ from geometry.mjs and text.mjs. Run through ./build.sh, which also
// makes the rasters. The SVGs are the source of truth and every letter in them is outlined.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CUTS, GROUND, INK, PALETTE, TEXT, X_BOX, X_PATH, markAt, markParts, placeMark, ringShapes, squircle, svgDoc,
} from './geometry.mjs'
import { CAPR, fonts, lockup, textPath } from './text.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'svg')
mkdirSync(out, { recursive: true })

const NAME = 'SlicerX'
const files = {}
const put = (name, svg) => { files[name] = svg }
const r2 = (v) => +v.toFixed(2)

// The app icon plates. The dark plate matches the iOS and macOS plates of the brand book.
const PLATE_DARK = ['#2b2d3c', '#15161d']
const PLATE_IOS_DARK = ['#232533', '#17181f']
const PLATE_LIGHT = ['#ffffff', '#e9eaf2']
// How much of the icon the X's height takes: 56 percent, the brand book's rule for icons.
const ICON_X = 0.56

const ramp = (id, [top, bottom]) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`

// ---------------------------------------------------------------- the mark, on clear

const markFile = (palette, cut = CUTS.full, label = NAME) => {
  const { defs, body } = markParts('', { palette, cut })
  return svgDoc(32, 32, body, { title: label, defs })
}
put('slicerx-mark.svg', markFile(PALETTE.dark))
put('slicerx-mark-light.svg', markFile(PALETTE.light))
put('slicerx-mark-small.svg', markFile(PALETTE.dark, CUTS.small))
put('slicerx-mark-small-light.svg', markFile(PALETTE.light, CUTS.small))
put('slicerx-mark-white.svg', markFile(PALETTE.white))
put('slicerx-mark-ink.svg', markFile(PALETTE.ink))

// ---------------------------------------------------------------- app icons, 1024 grid

/** A plate (any path or rect markup) with the X centered on it. */
function icon({ plate, plateDefs = '', palette, cut = CUTS.full, glow, xHeight, cx = 512, cy = 512, extra = '', title = NAME }) {
  const m = placeMark('i', cx, cy, xHeight, { palette, cut, glow })
  return svgDoc(1024, 1024, `${plate}${m.content}${extra}`, { title, defs: plateDefs + m.defs })
}
const GLOW_DARK = { opacity: 0.62, blur: 1.2 }
const GLOW_LIGHT = { opacity: 0.3, blur: 1.2 }
const full = (fill) => `<rect width="1024" height="1024" fill="${fill}"/>`

// iOS and iPadOS: a full square, because the system rounds the corners itself.
put('slicerx-app-icon.svg', icon({
  plate: full('url(#p)'), plateDefs: ramp('p', PLATE_IOS_DARK), palette: PALETTE.dark, glow: GLOW_DARK, xHeight: 1024 * ICON_X,
}))
put('slicerx-app-icon-light.svg', icon({
  plate: full('url(#p)'), plateDefs: ramp('p', PLATE_LIGHT), palette: PALETTE.light, glow: GLOW_LIGHT, xHeight: 1024 * ICON_X,
}))
// The tinted icon is gray on clear: the system lays its own color and ground over it. No glow,
// because a halo would tint into a smudge.
put('slicerx-app-icon-tinted.svg', icon({ plate: '', palette: PALETTE.mono, xHeight: 1024 * ICON_X }))

// macOS: a squircle plate on the 1024 grid with 100 px of margin and a soft shadow, the X at 56
// percent of the plate.
{
  const plate = squircle(100, 100, 824)
  const shadow =
    '<filter id="s" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="14"/>' +
    '<feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer></filter>'
  put('slicerx-app-icon-macos.svg', icon({
    plateDefs: ramp('p', PLATE_DARK) + shadow + `<clipPath id="pc"><path d="${plate}"/></clipPath>`,
    plate:
      `<path d="${plate}" fill="#000" filter="url(#s)"/><path d="${plate}" fill="url(#p)"/>` +
      // A one pixel inner highlight on the top edge, drawn inside the plate.
      `<g clip-path="url(#pc)"><path d="${plate}" fill="none" stroke="#fff" stroke-opacity="0.1" stroke-width="4"/></g>`,
    palette: PALETTE.dark, glow: GLOW_DARK, xHeight: 824 * ICON_X,
  }))
}

// macOS at 16 to 64 px: the small cut, no glow and no shadow, on the plate alone. Used for the
// small frames of the .icns, where the shadow's margin would cost a quarter of the icon.
{
  const plate = squircle(24, 24, 976)
  put('slicerx-app-icon-macos-small.svg', icon({
    plateDefs: ramp('p', PLATE_DARK), plate: `<path d="${plate}" fill="url(#p)"/>`,
    palette: PALETTE.dark, cut: CUTS.small, xHeight: 976 * 0.6,
  }))
}

// Windows: a square tile with a small radius, for Start and the Store. Sizes under 64 px use the
// small cut and no glow, made in raster.mjs from slicerx-app-icon-windows-small.svg.
const winPlate = `<rect width="1024" height="1024" rx="64" fill="url(#p)"/>`
put('slicerx-app-icon-windows.svg', icon({
  plate: winPlate, plateDefs: ramp('p', PLATE_DARK), palette: PALETTE.dark, glow: GLOW_DARK, xHeight: 1024 * 0.6,
}))
put('slicerx-app-icon-windows-small.svg', icon({
  plate: winPlate, plateDefs: ramp('p', PLATE_DARK), palette: PALETTE.dark, cut: CUTS.small, xHeight: 1024 * 0.66,
}))

// Android adaptive icon. The launcher masks the layers to a circle, squircle or teardrop and shows
// about 72 of 108 dp, with a safe zone of 66 dp. The X's diagonal is 1.38 times its height, so at
// 43 percent it stays inside a circle 61 percent of the canvas across.
const ANDROID_X = 1024 * 0.43
put('slicerx-android-foreground.svg', icon({ plate: '', palette: PALETTE.dark, glow: GLOW_DARK, xHeight: ANDROID_X }))
put('slicerx-android-background.svg', svgDoc(1024, 1024, full(GROUND.dark)))
// The themed layer: alpha only, which Android colors from the wallpaper.
put('slicerx-android-monochrome.svg', icon({ plate: '', palette: PALETTE.white, xHeight: ANDROID_X }))

// The tile: the mark on Nocturne's ground with rounded corners, for an avatar or anywhere a
// surface needs its own background.
const tile = (ground, palette, glow) =>
  icon({ plate: `<rect width="1024" height="1024" rx="230" fill="${ground}"/>`, palette, glow, xHeight: 1024 * ICON_X })
put('slicerx-tile.svg', tile(INK[0], PALETTE.dark, GLOW_DARK))
put('slicerx-tile-light.svg', tile(GROUND.light, PALETTE.light, GLOW_LIGHT))

// The splash mark, on clear: the app paints the ground.
put('slicerx-splash.svg', icon({ plate: '', palette: PALETTE.dark, glow: GLOW_DARK, xHeight: 700 }))
put('slicerx-splash-light.svg', icon({ plate: '', palette: PALETTE.light, glow: GLOW_LIGHT, xHeight: 700 }))

// ---------------------------------------------------------------- browser tab

{
  // Chrome and Firefox read the SVG and can ask for the tab strip's scheme. No tile: a dark tile
  // on a dark strip is an invisible box that only makes the mark smaller. The viewBox is cropped
  // to the X, which has 4.5 units of air on each side in the 32 unit grid and a tab has none to
  // spare. Safari reads no SVG icon and takes the .ico, made from the tile below.
  const { defs, body } = markParts('', { palette: PALETTE.dark, cut: CUTS.tab, classes: true })
  const style =
    `<style>.o{stroke:${PALETTE.dark.b}}.m{fill:${PALETTE.dark.a}}.i{stroke:${PALETTE.dark.c}}` +
    `@media (prefers-color-scheme: light){.o{stroke:${PALETTE.light.b}}.m{fill:${PALETTE.light.a}}.i{stroke:${PALETTE.light.c}}}</style>`
  put('slicerx-tab.svg', svgDoc(64, 64, body, { title: NAME, defs: defs + style, viewBox: '3.5 3.5 25 25' }))
}
// The tile for Safari: a clear icon it finds too dark gets a pale plate behind it, and an icon
// with a ground of its own is left alone. 32 and 48 px use the small cut.
function tabTile(cut, height, radius) {
  const m = placeMark('t', 16, 16, height, { palette: PALETTE.dark, cut })
  return svgDoc(32, 32, `<rect width="32" height="32" rx="${radius}" fill="${INK[0]}"/>${m.content}`, { title: NAME, defs: m.defs })
}
put('slicerx-tab-tile.svg', tabTile(CUTS.small, 22, 7))

/**
 * A 16 px frame. At 16 px the rings must land on whole pixels or the gaps blur into a gray smear, so
 * this is the tab cut at exactly half scale on a 16 unit grid: the X is 12 px tall (14 on clear),
 * the outline is 1 px, and the terminals sit on whole pixel rows.
 */
function hinted16({ ground, scale = 0.5 }) {
  const m = placeMark('h', 8, 8, 24 * scale, { palette: PALETTE.dark, cut: CUTS.tab })
  const plate = ground ? `<rect width="16" height="16" rx="${ground.rx}" fill="${ground.fill}"/>` : ''
  return svgDoc(16, 16, `${plate}${m.content}`, { title: NAME, defs: m.defs })
}
put('slicerx-tab-tile-16.svg', hinted16({ ground: { fill: INK[0], rx: 3.5 } }))
put('slicerx-app-icon-16.svg', hinted16({ ground: { fill: '#1c1d26', rx: 3.5 } }))
put('slicerx-mark-16.svg', hinted16({ scale: 14 / 24 }))

// ---------------------------------------------------------------- lockups

/** A lockup file with the clear space built in: 8 units of the mark's 32 unit grid on every side. */
function lockupFile({ ink, palette, size = 100, stacked = false, tagColor = TEXT.muted }) {
  const l = lockup({ size, ink, palette })
  const pad = 8 * l.s
  let body = l.content
  let w = l.w
  let h = l.h
  let x = l.x
  let y = l.y
  if (stacked) {
    // The word is centered over the descriptor. The mark never stacks above the word.
    const tagSize = size * 0.3
    const tag = textPath(fonts.body, 'The AI-ready slicer', tagSize, 0, 0, 0.01)
    const gap = l.cap * 0.62
    const tx = x + (w - tag.width) / 2
    const ty = y + h + gap + tagSize * 0.72
    const t = textPath(fonts.body, 'The AI-ready slicer', tagSize, tx, ty, 0.01)
    body += `<path fill="${tagColor}" d="${t.d}"/>`
    h = ty - y + tagSize * 0.25
  }
  const vb = `${r2(x - pad)} ${r2(y - pad)} ${r2(w + 2 * pad)} ${r2(h + 2 * pad)}`
  const W = r2(w + 2 * pad)
  const H = r2(h + 2 * pad)
  return svgDoc(W, H, body, { title: NAME, defs: l.defs, viewBox: vb })
}
put('slicerx-lockup.svg', lockupFile({ ink: TEXT.dark, palette: PALETTE.dark }))
put('slicerx-lockup-light.svg', lockupFile({ ink: TEXT.light, palette: PALETTE.light, tagColor: TEXT.mutedLight }))
put('slicerx-lockup-white.svg', lockupFile({ ink: TEXT.dark, palette: PALETTE.white }))
put('slicerx-lockup-ink.svg', lockupFile({ ink: TEXT.light, palette: PALETTE.ink }))
put('slicerx-lockup-stacked.svg', lockupFile({ ink: TEXT.dark, palette: PALETTE.dark, stacked: true }))
put('slicerx-lockup-stacked-light.svg', lockupFile({ ink: TEXT.light, palette: PALETTE.light, stacked: true, tagColor: TEXT.mutedLight }))

// ---------------------------------------------------------------- README banner

function banner(theme) {
  const dark = theme === 'dark'
  const W = 1280
  const H = 360
  const bg = dark ? INK[0] : '#f8f8f2'
  const fg = dark ? TEXT.dark : TEXT.light
  const muted = dark ? TEXT.muted : '#4a4f6a'
  const dim = dark ? TEXT.dim : '#6b7090'
  const hair = dark ? INK[2] : '#dcdde6'
  const size = 132
  const l = lockup({ size, ink: fg, palette: dark ? PALETTE.dark : PALETTE.light })
  // Center the lockup by its visible artwork, and put the baseline where the old banner had it.
  const baseline = 196
  const tx = Math.round((W - l.w) / 2 - l.x)
  let body = `<rect width="${W}" height="${H}" rx="16" fill="${bg}"/>`
  let lines = ''
  for (let y = 12; y < H; y += 12) lines += `<path d="M0 ${y}H${W}"/>`
  body += `<g stroke="${hair}" stroke-width="1">${lines}</g>`
  // The halo sits behind the X on the dark banner only. On the light banner it would read as dirt.
  const mk = markAt('b', tx + l.mx, baseline + l.my, l.s, { palette: dark ? PALETTE.dark : PALETTE.light, glow: dark ? { opacity: 0.55, blur: 1.1 } : 0 })
  const word = l.content.split('<g transform')[0]
  body += `<g transform="translate(${tx} ${baseline})">${word}</g>${mk.content}`
  const tagStr = 'The AI-ready slicer. Free and open source.'
  const tag = textPath(fonts.body, tagStr, 30, 0, 0)
  const tagP = textPath(fonts.body, tagStr, 30, Math.round((W - tag.width) / 2), 262)
  const meta = 'RUST CORE   WEBASSEMBLY   EVERY PRINTER   MCP SERVER'
  const m = textPath(fonts.mono, meta, 15, 0, 0, 0.08)
  const mP = textPath(fonts.mono, meta, 15, Math.round((W - m.width) / 2), 312, 0.08)
  body += `<path fill="${muted}" d="${tagP.d}"/><path fill="${dim}" d="${mP.d}"/>`
  return svgDoc(W, H, body, {
    title: NAME, defs: mk.defs,
    desc: 'The SlicerX logo: the word Slicer followed by a layered X mark in a purple to pink gradient. Tagline: The AI-ready slicer. Free and open source.',
  })
}
put('slicerx-banner-dark.svg', banner('dark'))
put('slicerx-banner-light.svg', banner('light'))

// ---------------------------------------------------------------- social cards

/**
 * The card art with no words: the ground, layer hairlines, and a large X standing in the lower
 * right with the slice plane through it. Layers below the plane are laid and lit, layers above it
 * are a ghost of what is still to print. The words go on top, live in the site's route and
 * outlined in the static files, so the two share one layout, which the numbers here define.
 */
export const CARD = { w: 1200, h: 630, pad: 84, x: { cx: 1020, cy: 335, height: 540 } }

function cardArt() {
  const { w, h } = CARD
  const { cx, cy, height } = CARD.x
  const s = height / X_BOX.h
  const ox = cx - X_BOX.cx * s
  const oy = cy - X_BOX.cy * s
  // Rings below the plane are laid and lit, rings above are a ghost of what is still to print.
  const planeUnit = 13.4
  const planeY = oy + planeUnit * s
  const { defs: glowDefs, halo } = markParts('o', { palette: PALETTE.dark, glow: { opacity: 0.5, blur: 1.1 } })
  const ghost = markParts('g', { palette: PALETTE.dark }).body
  const lit = markParts('l', { palette: PALETTE.dark }).body
  const defs = glowDefs + `<clipPath id="below"><rect x="-8" y="${planeUnit}" width="48" height="40"/></clipPath>`
  let lines = ''
  for (let y = 12; y < h; y += 12) lines += `<path d="M0 ${y}H${w}"/>`
  const plane =
    `<linearGradient id="pl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${PALETTE.dark.a}" stop-opacity="0"/>` +
    `<stop offset=".18" stop-color="${PALETTE.dark.a}"/><stop offset=".5" stop-color="#e4d4ff"/><stop offset=".82" stop-color="${PALETTE.dark.a}"/>` +
    `<stop offset="1" stop-color="${PALETTE.dark.a}" stop-opacity="0"/></linearGradient>` +
    `<filter id="pb" x="-10%" y="-400%" width="120%" height="900%"><feGaussianBlur stdDeviation="9"/></filter>`
  const body =
    `<rect width="${w}" height="${h}" fill="${INK[0]}"/>` +
    `<g stroke="${INK[2]}" stroke-width="1" opacity=".7">${lines}</g>` +
    `<g transform="translate(${r2(ox)} ${r2(oy)}) scale(${+s.toFixed(4)})">${halo}` +
    `<g opacity=".16">${ghost}</g><g clip-path="url(#below)">${lit}</g></g>` +
    // The plane: a glow and a hairline.
    `<rect x="${w * 0.42}" y="${r2(planeY - 8)}" width="${w * 0.58}" height="16" fill="${PALETTE.dark.a}" opacity=".55" filter="url(#pb)"/>` +
    `<rect x="${w * 0.42}" y="${r2(planeY - 1)}" width="${w * 0.58}" height="2" rx="1" fill="url(#pl)"/>`
  // Fade the ground into the left edge so type has quiet air behind it.
  const veil =
    `<linearGradient id="vl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${INK[0]}" stop-opacity=".92"/><stop offset=".55" stop-color="${INK[0]}" stop-opacity=".55"/><stop offset="1" stop-color="${INK[0]}" stop-opacity="0"/></linearGradient>`
  return { defs: defs + plane + veil, body: body + `<rect width="${w * 0.66}" height="${h}" fill="url(#vl)"/>` }
}

/** The card, with words outlined. `variant` picks the crop and the size. */
function card({ w = CARD.w, h = CARD.h } = {}) {
  const art = cardArt()
  const pad = CARD.pad
  const l = lockup({ size: 64, ink: TEXT.dark, palette: PALETTE.dark })
  const lx = pad - l.x
  const ly = pad - l.y
  const head = ['A Rust-based open source slicer', 'for builders and makers.']
  const hp = head.map((t, i) => textPath(fonts.bodyBold, t, 54, pad, 380 + i * 76).d).join('')
  const tag = textPath(fonts.body, 'The AI-ready slicer', 30, pad, 510).d
  const foot = textPath(fonts.mono, 'slicerx.app', 22, pad, h === CARD.h ? 570 : 570, 0.04).d
  const oss = textPath(fonts.mono, 'FREE AND OPEN SOURCE', 15, pad + 172, 570, 0.08).d
  const body = `${art.body}<g transform="translate(${r2(lx)} ${r2(ly)})">${l.content}</g>` +
    `<path fill="${TEXT.dark}" d="${hp}"/><path fill="${TEXT.muted}" d="${tag}"/>` +
    `<path fill="${TEXT.dim}" d="${foot}"/><path fill="${TEXT.dim}" d="${oss}"/>`
  return svgDoc(w, h, body, {
    title: `${NAME}. A Rust-based open source slicer for builders and makers.`,
    defs: art.defs + l.defs,
    viewBox: `0 0 ${CARD.w} ${CARD.h}`,
  }).replace('<svg ', '<svg preserveAspectRatio="xMidYMid slice" ')
}
put('slicerx-og.svg', card())
put('slicerx-github-social.svg', card({ w: 1280, h: 640 }))
// The art and the lockup alone, for the site's opengraph-image route, which sets the words itself.
{
  const art = cardArt()
  put('slicerx-og-art.svg', svgDoc(CARD.w, CARD.h, art.body, { defs: art.defs }))
}

// The numbers other code needs: paths.json for anything that draws the mark itself, and
// layout.json for the site's opengraph-image route, which sets the card's words live.
{
  const k = 64 / 100
  const l = lockup({ size: 100 })
  const clear = 8 * l.s
  const round = (v) => +v.toFixed(2)
  writeFileSync(join(here, 'paths.json'), JSON.stringify({
    x: X_PATH, box: X_BOX,
    cuts: CUTS, palette: { dark: PALETTE.dark, light: PALETTE.light },
    ink: INK, ground: GROUND,
  }, null, 1) + '\n')
  writeFileSync(join(here, 'layout.json'), JSON.stringify({
    card: { width: CARD.w, height: CARD.h, pad: CARD.pad },
    // Where the padded lockup image goes so its visible artwork starts at the card's padding.
    lockup: {
      left: round(CARD.pad - clear * k), top: round(CARD.pad - clear * k),
      width: round((l.w + 2 * clear) * k), height: round((l.h + 2 * clear) * k),
    },
    // Baselines of the words in the static card, for the live version to match.
    headline: { size: 54, baseline: [380, 456], lineHeight: 76 },
    tagline: { size: 30, baseline: 510 },
    foot: { size: 22, baseline: 570 },
  }, null, 1) + '\n')
}

for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text)
console.log(`${Object.keys(files).length} svg written to svg/`)
