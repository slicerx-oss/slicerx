// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Look lab: one still of a lab scene with a shading and a studio, for side by side picks, plus measurements.
// Query: scene (look-models.ts), shade (base, new), studio (dark, light, precision, graphite, lightnew), tab (model, slice,
// lines, paths), cam (wide, close), sel (1 selects the first object), p (JSON patch on the look), nolook (1: never call setLook).
// Sets window.__lookReady once the still frame has settled; window.__lab has the measuring helpers.
import type { ViewportLookPatch, ViewportTheme } from '../src/index'
import { createViewport, readPreview } from '../src/index'
import { SphericalHarmonics3, Vector3, type PerspectiveCamera, type WebGLRenderer, type WebGLRenderTarget } from 'three'
import { subbanLight } from '../../src/themes'
import { labParts, type LabScene } from './look-models'
import { STUDIOS, compose, type ShadeId, type StudioId } from './looks'
import { synthesizePreview, type SynthPart } from './synth-sxpv'

declare global {
  interface Window {
    __lookReady?: boolean
    __lookInfo?: unknown
    __lab?: unknown
  }
}

const q = new URLSearchParams(location.search)
const scene = (q.get('scene') ?? 'organic') as LabScene
const shade = (q.get('shade') ?? 'base') as ShadeId
const studioId = (q.get('studio') ?? 'dark') as StudioId
const studio = STUDIOS[studioId]
const tab = q.get('tab') ?? 'slice'
const camName = q.get('cam') ?? 'close'
const patch = JSON.parse(q.get('p') ?? '{}') as ViewportLookPatch
const noLook = q.get('nolook') === '1'

function lightTheme(): ViewportTheme {
  const s = subbanLight.scene!
  const c = subbanLight.colors
  return {
    scene: {
      ...(s.top ? { bgTop: s.top } : {}),
      ...(s.bottom ? { bgBottom: s.bottom } : {}),
      ...(s.glow ? { bgGlow: s.glow } : {}),
      ...(s.plate ? { plateSide: s.plate } : {}),
      ...(s.grid ? { floorGrid: s.grid } : {}),
      ...(s.edge ? { edgeDark: s.edge } : {}),
      ...(s.xray ? { edgeXray: s.xray } : {}),
      selection: c.purple,
      liveLayer: c.cyan,
    },
  }
}

const canvas = document.getElementById('vp') as HTMLCanvasElement
const vp = createViewport(canvas, { quality: 'high', maxPixelRatio: 2, adaptive: false, reveal: false, ...(studio.theme === 'light' ? { theme: lightTheme() } : {}) })
const bed = { widthMm: 256, depthMm: 256, heightMm: 256 }
const parts = labParts(scene)
vp.setPlate({
  bed,
  surfaceLabel: 'Textured PEI',
  objects: parts.map((p, i) => ({
    id: `p${i}`,
    name: p.name,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p.at[0], p.at[1], 0, 1],
    parts: [{ name: p.name, positions: p.positions, indices: p.indices, color: p.color, finish: 'basic' as const }],
  })),
})
vp.setToolColors(parts.map((p) => p.color))
vp.setMode('prepare')
vp.setRenderMode(tab === 'model' ? 'cad' : 'studio')
// the Slice tab's Solid look has no layer grooves; Layer lines (tab=lines) draws them at 0.2 mm, as the app does
vp.setPrintLook(tab === 'lines', 0.2)
if (q.get('sel') === '1') vp.setSelection(['p0'])

type Cam = { target: [number, number, number]; azimuthDeg: number; elevationDeg: number; distanceMm: number }
// one camera per scene and distance, the same for every look
const WIDE: Cam = { target: [128, 118, 18], azimuthDeg: -30, elevationDeg: 34, distanceMm: 560 }
const CLOSE: Record<LabScene, Cam> = {
  organic: { target: [128, 128, 36], azimuthDeg: -24, elevationDeg: 20, distanceMm: 400 },
  mech: { target: [140, 105, 14], azimuthDeg: -32, elevationDeg: 34, distanceMm: 250 },
  dark: { target: [145, 118, 34], azimuthDeg: -28, elevationDeg: 26, distanceMm: 360 },
  block: { target: [128, 128, 16], azimuthDeg: -32, elevationDeg: 30, distanceMm: 230 },
  black: { target: [138, 128, 16], azimuthDeg: -30, elevationDeg: 32, distanceMm: 300 },
  color: { target: [150, 110, 14], azimuthDeg: -28, elevationDeg: 34, distanceMm: 300 },
  mixed: { target: [128, 120, 18], azimuthDeg: -30, elevationDeg: 32, distanceMm: 420 },
}
const cam: Cam = camName === 'wide' ? WIDE : CLOSE[scene]

interface Internals {
  camera: PerspectiveCamera
  renderer: WebGLRenderer
  stage: { envSH: Vector3[] | null; bedRoot: { matrixWorld: import('three').Matrix4 } }
  pipeline: { main: WebGLRenderTarget }
  renderFrame(aoMix: number, moving: boolean): void
}
const I = vp as unknown as Internals

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function settle(): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const s = vp.stats()
    if (s.refiningParts === 0 && !s.cameraMoving && s.firstDrawMs !== null) return
    await sleep(50)
  }
}

/** Draws a still frame now and reads it back: the canvas (sRGB, 8 bit) and the scene pass's coverage (alpha). */
function grab(): { w: number; h: number; rgb: Uint8Array; cover: Uint8Array; hdr: Float32Array } {
  I.renderFrame(1, false)
  const gl = I.renderer.getContext()
  const w = gl.drawingBufferWidth
  const h = gl.drawingBufferHeight
  const rgba = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
  const half = new Uint16Array(w * h * 4)
  I.renderer.readRenderTargetPixels(I.pipeline.main, 0, 0, w, h, half)
  const hdr = new Float32Array(w * h * 4)
  for (let i = 0; i < half.length; i++) hdr[i] = halfToFloat(half[i]!)
  const rgb = new Uint8Array(w * h * 3)
  const cover = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = rgba[i * 4]!
    rgb[i * 3 + 1] = rgba[i * 4 + 1]!
    rgb[i * 3 + 2] = rgba[i * 4 + 2]!
    cover[i] = hdr[i * 4 + 3]! >= 0.99 ? 1 : 0
  }
  return { w, h, rgb, cover, hdr }
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Final picture stats over the models' pixels (coverage) and the backdrop around them. */
function stats(): unknown {
  const { w, h, rgb, cover, hdr } = grab()
  const L = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) L[i] = luma(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!)
  const obj: number[] = []
  const hdrPeak: number[] = []
  let grad = 0
  let gradN = 0
  let bg = 0
  let bgN = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (!cover[i]) {
        bg += L[i]!
        bgN++
        continue
      }
      obj.push(L[i]!)
      hdrPeak.push(Math.max(hdr[i * 4]!, hdr[i * 4 + 1]!, hdr[i * 4 + 2]!))
      // shape detail: luminance change to the right and below, inside the model only
      if (cover[i + 1] && cover[i + w]) {
        grad += Math.abs(L[i + 1]! - L[i]!) + Math.abs(L[i + w]! - L[i]!)
        gradN++
      }
    }
  }
  obj.sort((a, b) => a - b)
  hdrPeak.sort((a, b) => a - b)
  const pc = (a: number[], p: number) => (a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))]! * 1000) / 1000 : null)
  const clip = obj.filter((v) => v >= 250).length / Math.max(1, obj.length)
  const crush = obj.filter((v) => v <= 12).length / Math.max(1, obj.length)
  // distinct 8-bit levels used by the models: few levels means flat
  const levels = new Set(obj.map((v) => Math.round(v))).size
  return {
    objPx: obj.length,
    p01: pc(obj, 0.01), p05: pc(obj, 0.05), p50: pc(obj, 0.5), p95: pc(obj, 0.95), p99: pc(obj, 0.99),
    clip: Math.round(clip * 10000) / 10000,
    crush: Math.round(crush * 10000) / 10000,
    levels,
    detail: Math.round((grad / Math.max(1, gradN)) * 1000) / 1000,
    hdrP50: pc(hdrPeak, 0.5), hdrP95: pc(hdrPeak, 0.95), hdrP99: pc(hdrPeak, 0.99),
    bgMean: Math.round((bg / Math.max(1, bgN)) * 100) / 100,
  }
}

/** Mean sRGB color (0 to 255) and linear HDR of a small patch around bed points (mm, Z up), and whether each faces the camera. */
function sample(points: [number, number, number][], r = 4): unknown {
  const { w, h, rgb, hdr } = grab()
  const bedW = I.stage.bedRoot.matrixWorld
  return points.map((p) => {
    const v = new Vector3(...p).applyMatrix4(bedW).project(I.camera)
    const cx = Math.round((v.x * 0.5 + 0.5) * w)
    const cy = Math.round((v.y * 0.5 + 0.5) * h)
    let n = 0
    const s = [0, 0, 0]
    const H = [0, 0, 0]
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const i = y * w + x
        for (let c = 0; c < 3; c++) {
          s[c]! += rgb[i * 3 + c]!
          H[c]! += hdr[i * 4 + c]!
        }
        n++
      }
    const m = s.map((x) => Math.round(x / Math.max(1, n)))
    return { at: p, px: [cx, h - cy], srgb: m, hex: '#' + m.map((x) => x.toString(16).padStart(2, '0')).join(''), hdr: H.map((x) => Math.round((x / Math.max(1, n)) * 1000) / 1000) }
  })
}

/**
 * The backdrop along a vertical line: the 8-bit levels down column x (device px), raw, and averaged over a band of
 * columns. Banding shows as long runs of one level in the raw column; dither turns them into a mix of neighbors.
 */
function column(x: number, band = 1): unknown {
  const { w, h, rgb } = grab()
  const raw: number[] = []
  const runs: number[] = []
  let run = 1
  for (let y = 0; y < h; y++) {
    let g = 0
    for (let k = 0; k < band; k++) g += rgb[(y * w + Math.min(w - 1, x + k)) * 3 + 1]!
    raw.push(Math.round((g / band) * 10) / 10)
    if (y > 0 && raw[y] === raw[y - 1]) run++
    else if (y > 0) {
      runs.push(run)
      run = 1
    }
  }
  runs.push(run)
  runs.sort((a, b) => b - a)
  return { longestRuns: runs.slice(0, 5), distinct: new Set(raw).size, raw: raw.filter((_, i) => i % 8 === 0) }
}

/** GPU cost of still and moving frames over a slow turn (setGpuTiming waits for the GPU each frame), in ms. */
async function perf(frames = 40): Promise<unknown> {
  const run = (moving: boolean): { p50: number; p95: number } => {
    vp.setGpuTiming(true)
    vp.resetStats()
    for (let i = 0; i < frames; i++) {
      vp.setCamera({ ...cam, azimuthDeg: cam.azimuthDeg + i * 2 }, { animate: false })
      I.renderFrame(moving ? 0 : 1, moving)
    }
    const c = vp.stats().costMs.slice().sort((a, b) => a - b)
    vp.setGpuTiming(false)
    return { p50: Math.round(c[Math.floor(c.length / 2)]! * 100) / 100, p95: Math.round(c[Math.floor(c.length * 0.95)]! * 100) / 100 }
  }
  run(false)
  const still = run(false)
  const moving = run(true)
  vp.setCamera(cam, { animate: false })
  return { still, moving }
}

/**
 * Interactive turn: the viewport's own loop draws while the camera turns a little every animation frame for `ms`, the
 * way a drag does. Reports the frame interval, the motion tuner's level and the GPU cost of moving frames.
 */
async function orbit(ms = 3000): Promise<unknown> {
  vp.resetStats()
  const t0 = performance.now()
  let n = 0
  await new Promise<void>((done) => {
    const step = (t: number) => {
      vp.setCamera({ ...cam, azimuthDeg: cam.azimuthDeg + ((t - t0) / ms) * 90 }, { animate: false })
      n++
      if (t - t0 < ms) requestAnimationFrame(step)
      else done()
    }
    requestAnimationFrame(step)
  })
  const s = vp.stats()
  const f = s.frameMs.slice().sort((a, b) => a - b)
  vp.setCamera(cam, { animate: false })
  return { steps: n, frames: f.length, frameP50: Math.round(f[Math.floor(f.length / 2)]! * 100) / 100, frameP95: Math.round(f[Math.floor(f.length * 0.95)]! * 100) / 100, motionFull: s.motionFull, motionScale: s.motionScale, renderP50: s.p50 }
}

window.__lab = { stats, sample, column, perf, orbit, vp, cam, look: () => vp.look() }

void (async () => {
  if (tab === 'paths') {
    const synth: SynthPart[] = parts.map((p, i) => {
      const pos = new Float32Array(p.positions.length)
      for (let k = 0; k < pos.length; k += 3) {
        pos[k] = p.positions[k]! + p.at[0]
        pos[k + 1] = p.positions[k + 1]! + p.at[1]
        pos[k + 2] = p.positions[k + 2]!
      }
      return { positions: pos, indices: p.indices, tool: i, object: i }
    })
    vp.setPreview(readPreview(synthesizePreview(synth, { layerHeight: 0.2, lineWidth: 0.42, walls: 2, infillPct: 15, brimMm: 0 })))
    vp.setMode('preview')
    vp.setColorMode('tool')
  }
  vp.setCamera(cam, { animate: false })
  await settle()
  // a slow first build can frame the plate after the first call, so set the view again once it has settled
  vp.setCamera(cam, { animate: false })
  await settle()
  const t0 = performance.now()
  if (!noLook) vp.setLook(compose(shade, studioId, patch))
  await sleep(500)
  await settle()
  await sleep(900)
  const s = vp.stats()
  const shc = I.stage.envSH
  let env: unknown = null
  if (shc) {
    const sh = new SphericalHarmonics3().set(shc)
    const v = (d: Vector3) => Math.round(sh.getIrradianceAt(d, new Vector3()).y * 1000) / 1000
    env = { up: v(new Vector3(0, 1, 0)), side: v(new Vector3(1, 0, 0)), down: v(new Vector3(0, -1, 0)) }
  }
  window.__lookInfo = { env, gpu: s.gpu, pixelRatio: s.pixelRatio, width: s.width, height: s.height, aoOn: s.aoOn, applyMs: Math.round(performance.now() - t0) }
  window.__lookReady = true
})()
