// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exports the tooltip loops as files that chat apps play: MP4 and GIF per loop and theme.
//   node loops-export.mjs svg <outdir> [loop ids]          standalone animated SVGs (dark and light)
//   node loops-export.mjs frames <svgdir> <framesdir> [names]  30 fps PNG frames, one 3.5 s cycle, headless Chromium
//   node loops-export.mjs encode <framesdir> <outdir> [names]  <name>.mp4 (H.264) and <name>.gif (15 fps, 592 px)
// Loop ids are the demo module names (push, sketch, ...); names are the svg file stems (push-pull-dark, ...).
// Chromium comes from playwright-core (set PLAYWRIGHT_CORE to its folder if it is not resolvable); ffmpeg is
// FFMPEG or the one on PATH.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')
const NAMES = { push: 'push-pull', sketch: 'sketch', face: 'on-a-face', add: 'add', fillet: 'fillet', shell: 'shell', subtract: 'subtract', cut: 'cut', array: 'array', hole: 'hole', thread: 'thread', mesh: 'simplify-mesh', sleipnir: 'sleipnir', aegis: 'aegis', atlas: 'atlas', heimdall: 'heimdall', norn: 'norn', 'layer-height': 'layer-height', 'strength': 'strength', 'infill-density': 'infill-density', 'wall-loops': 'wall-loops', 'speed': 'speed', 'speed-quality': 'speed-quality', 'speed-balanced': 'speed-balanced', 'speed-fast': 'speed-fast', 'speed-fastest': 'speed-fastest', 'supports': 'supports', 'supports-off': 'supports-off', 'supports-auto': 'supports-auto', 'supports-painted': 'supports-painted', 'enable-support': 'enable-support', 'brim': 'brim', 'brim-type': 'brim-type', 'history-suppress': 'history-suppress', 'history-view': 'history-view', 'history-earlier': 'history-earlier', 'history-later': 'history-later', 'keep-dimension': 'keep-dimension', 'mirror-x': 'mirror-x', 'mirror-y': 'mirror-y', 'mirror-z': 'mirror-z', 'print-sequence': 'print-sequence', 'whole-loop': 'whole-loop', 'drop-to-bed': 'drop-to-bed', 'round-corners': 'round-corners', 'brim-ears': 'brim-ears', 'move': 'move', 'lay-on-face': 'lay-on-face', 'rotate': 'rotate', 'scale': 'scale', 'adv-bridge-sag': 'bridge-sag', 'adv-internal-bridge': 'internal-bridge', 'adv-outer-wall-speed': 'outer-wall-speed', 'preview-markers-retractions': 'markers-retractions', 'preview-markers-seams': 'markers-seams', 'preview-markers-z-hops': 'markers-z-hops', 'preview-markers-wipes': 'markers-wipes', 'preview-markers-tool-changes': 'markers-tool-changes', 'preview-markers-pauses': 'markers-pauses' }
const CYCLE = 3.5
const FPS = 30

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const mix = (a, b, p) => '#' + hex(a).map((v, i) => Math.round(v * p + hex(b)[i] * (1 - p)).toString(16).padStart(2, '0')).join('')
function theme(accent, red, cyan, grid, top, bottom, t, ol, pill, a1, a2, a3, aol) {
  return { top, bottom, vars: { '--stage-pill-text': '#f8f8f2', '--stage-pill-line': 'rgb(255 255 255 / 18%)', '--stage-grid': grid, '--stage-ptr': 'white', '--stage-ptr-line': '#111218', '--accent': accent, '--red': red, '--cyan': cyan, '--scene-grid': grid, '--stage-t1': t[0], '--stage-t2': t[1], '--stage-t3': t[2], '--stage-ol': ol, '--stage-a1': a1, '--stage-a2': a2, '--stage-a3': a3, '--stage-aol': aol, '--stage-cut': red, '--stage-pill': pill, '--f-body': 'system-ui, -apple-system, sans-serif' } }
}
const D = '#bd93f9'
const L = '#7542bd'
const THEMES = {
  dark: theme(D, '#ff5555', '#8be9fd', '#5a5e74', '#2f3241', '#20222b', ['#d6d8e4', '#9da1b6', '#6c7086'], '#1a1b24', '#16171e', mix(D, '#ffffff', 0.72), mix(D, '#000000', 0.88), mix(D, '#000000', 0.64), mix(D, '#000000', 0.22)),
  light: theme(L, '#c33c3c', '#008494', '#8b8395', '#fdfcff', '#e1d7eb', ['#ffffff', '#cfccd9', '#9b97a8'], '#36333f', '#2d2834', mix(L, '#ffffff', 0.78), L, mix(L, '#000000', 0.8), mix(L, '#000000', 0.4)),
}

async function svgs(out, ids) {
  const { stageInner, STAGE_W, STAGE_H } = await import(pathToFileURL(path.join(ROOT, 'packages/ui/src/components/tooltip-stage-svg.ts')).href)
  mkdirSync(out, { recursive: true })
  let n = 0
  for (const id of ids) {
    const name = NAMES[id] ?? id
    const { loop } = await import(pathToFileURL(path.join(ROOT, 'packages/app/src/demos', `${id}.ts`)).href)
    for (const [tn, t] of Object.entries(THEMES)) {
      let inner = stageInner(loop)
      // resolve every var() so any viewer draws the same colors
      for (let i = 0; i < 4; i++) inner = inner.replace(/var\((--[\w-]+)(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (m, v, fb) => t.vars[v] ?? (fb ? fb.trim() : m))
      const bg = `<linearGradient id="vp-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.top}"/><stop offset="1" stop-color="${t.bottom}"/></linearGradient><rect width="${STAGE_W}" height="${STAGE_H}" fill="url(#vp-bg)"/>`
      const svg = `<svg class="sxs" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STAGE_W} ${STAGE_H}" width="${STAGE_W * 2}" height="${STAGE_H * 2}" role="img" aria-label="${name}">${bg}${inner}</svg>\n`
      if (/var\(/.test(svg)) throw new Error(`${name} ${tn}: unresolved var`)
      writeFileSync(path.join(out, `${name}-${tn}.svg`), svg)
      n++
    }
  }
  console.log('svg files', n)
}

const stems = (dir, ext, only) => readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)).filter((s) => !only.length || only.some((o) => s === o || s.startsWith(o + '-'))).sort()

async function frames(svgDir, out, only) {
  const require = createRequire(import.meta.url)
  const pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core')
  // without this flag compositor-driven opacity fades lag the frozen clock
  const b = await pw.chromium.launch({ args: ['--disable-threaded-animation'] })
  const p = await b.newPage({ viewport: { width: 592, height: 332 } })
  for (const name of stems(svgDir, '.svg', only)) {
    const od = path.join(out, name)
    mkdirSync(od, { recursive: true })
    await p.goto(pathToFileURL(path.join(svgDir, `${name}.svg`)).href)
    await p.waitForTimeout(150)
    for (let k = 0; k < CYCLE * FPS; k++) {
      // freeze both the CSS and the SMIL clocks at the frame time, so the cycle is exact
      await p.evaluate((t) => {
        for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000 }
        const s = document.documentElement
        if (s.pauseAnimations) { s.pauseAnimations(); s.setCurrentTime(t) }
      }, k / FPS)
      await p.screenshot({ path: path.join(od, `${String(k).padStart(3, '0')}.png`) })
    }
    console.log('frames', name)
  }
  await b.close()
}

function ff(args) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('ffmpeg failed')
}

function encode(framesDir, out, only) {
  mkdirSync(out, { recursive: true })
  const names = readdirSync(framesDir).filter((n) => !only.length || only.some((o) => n === o || n.startsWith(o + '-'))).sort()
  for (const name of names) {
    const f = path.join(framesDir, name, '%03d.png')
    ff(['-framerate', String(FPS), '-i', f, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', path.join(out, `${name}.mp4`)])
    // every second frame, 15 fps, one palette per file
    ff(['-framerate', '15', '-i', f, '-vf', "select='not(mod(n,2))',setpts=N/(15*TB),scale=592:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", '-loop', '0', path.join(out, `${name}.gif`)])
    console.log('encoded', name)
  }
}

const [cmd, a, b, ...rest] = process.argv.slice(2)
if (cmd === 'svg') await svgs(a, [b, ...rest].filter(Boolean).length ? [b, ...rest].filter(Boolean) : Object.keys(NAMES))
else if (cmd === 'frames') await frames(a, b, rest)
else if (cmd === 'encode') encode(a, b, rest)
else { console.error('usage: loops-export.mjs svg|frames|encode ...'); process.exit(2) }
