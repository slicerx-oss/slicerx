// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Demo page for @slicerx/viewport and the page the frame-time benchmark drives.
// Query parameters: copies (reference models on the plate, default 1),
// mode (prepare or preview), quality, pr (max pixel ratio), sxpv (URL of a
// real SXPV file to load instead of the synthetic one).
import { readPreview, type Bed, type PreviewBuffers } from '@slicerx/contracts'
import { createViewport, FEATURE_COLORS, HEAT_RAMP, summarizePreview, type ColorMode, type Quality, type RenderMode, type ViewportObject, type ViewportStats } from '../src/index'
import { referenceModel } from './models'
import { synthesizePreview, type SynthPart } from './synth-sxpv'

const q = new URLSearchParams(location.search)
const copies = Math.max(1, Math.min(16, Number(q.get('copies') ?? 1)))
const quality = (q.get('quality') ?? 'high') as Quality
const maxPr = Number(q.get('pr') ?? 2)

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

if (q.get('bare') === '1') document.body.classList.add('bare')
const canvas = $<HTMLCanvasElement>('vp')
const vp = createViewport(canvas, { controls: (q.get('controls') as 'slicerx' | 'bambu-studio' | 'prusaslicer' | 'orcaslicer' | null) ?? 'slicerx', quality, maxPixelRatio: maxPr, adaptive: q.get('adaptive') !== '0' })
vp.on('degrade', (e) => console.warn(e.message))
vp.on('error', (e) => console.error(e.message))

// Plate: copies of the reference model on a grid, bed grown to fit.
const parts = referenceModel()
const cols = Math.ceil(Math.sqrt(copies))
const rows = Math.ceil(copies / cols)
const pitch = 96
const side = Math.max(256, Math.ceil(Math.max(cols, rows) * pitch + 40))
const bed: Bed = { widthMm: side, depthMm: side, heightMm: 256 }
const objects: ViewportObject[] = []
for (let i = 0; i < copies; i++) {
  const cx = bed.widthMm / 2 + ((i % cols) - (cols - 1) / 2) * pitch
  const cy = bed.depthMm / 2 + (Math.floor(i / cols) - (rows - 1) / 2) * pitch
  objects.push({
    id: `lamp-${i + 1}`,
    name: `Lamp ${i + 1}`,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, cy, 0, 1],
    parts: parts.map((p) => ({ name: p.name, positions: p.positions, indices: p.indices, color: p.color, finish: 'basic' })),
  })
}
vp.setPlate({ bed, objects, surfaceLabel: 'Textured PEI' })
const toolColors = parts.map((p) => p.color)
vp.setToolColors(toolColors)

async function loadPreview(): Promise<PreviewBuffers> {
  const url = q.get('sxpv')
  if (url) return readPreview(await (await fetch(url)).arrayBuffer())
  const synth: SynthPart[] = []
  objects.forEach((o, oi) => {
    const tx = o.transform[12] ?? 0
    const ty = o.transform[13] ?? 0
    parts.forEach((p, pi) => {
      const pos = new Float32Array(p.positions.length)
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] = (p.positions[i] ?? 0) + tx
        pos[i + 1] = (p.positions[i + 1] ?? 0) + ty
        pos[i + 2] = p.positions[i + 2] ?? 0
      }
      synth.push({ positions: pos, indices: p.indices, tool: pi, object: oi })
    })
  })
  return readPreview(synthesizePreview(synth, { layerHeight: 0.2, lineWidth: 0.42, walls: 2, infillPct: 15, brimMm: 5 }))
}

let preview: PreviewBuffers | null = null
const hud = $('hud')
const hi = $<HTMLInputElement>('hi')
const lo = $<HTMLInputElement>('lo')
const mv = $<HTMLInputElement>('mv')

function readout(): void {
  const b = preview
  if (!b) return
  const k = Number(hi.value)
  $('hi-v').textContent = `${k + 1} of ${b.layerCount}`
  $('lo-v').textContent = `${Number(lo.value) + 1}`
  const moves = (b.layerStart[k + 1] ?? 0) - (b.layerStart[k] ?? 0)
  const m = Number(mv.value)
  $('mv-v').textContent = m >= 1000 ? 'all' : `${Math.round((moves * m) / 1000)} of ${moves}`
  hud.textContent = `Z ${(b.layerZ[k] ?? 0).toFixed(2)} mm  layer ${k + 1}  ${(b.layerTimeS[k] ?? 0).toFixed(1)} s  ${b.segmentCount.toLocaleString('en-US')} segments`
}

function applyRange(): void {
  const b = preview
  if (!b) return
  const k = Number(hi.value)
  if (Number(lo.value) > k) lo.value = String(k)
  vp.setLayerRange(Number(lo.value), k)
  const m = Number(mv.value)
  const moves = (b.layerStart[k + 1] ?? 0) - (b.layerStart[k] ?? 0)
  vp.setMoveCut(m >= 1000 ? null : Math.round((moves * m) / 1000))
  readout()
}

function legend(mode: ColorMode): void {
  const ul = $('legend')
  ul.textContent = ''
  const add = (color: string, label: string): void => {
    const li = document.createElement('li')
    const i = document.createElement('i')
    i.style.background = color
    li.append(i, label)
    ul.append(li)
  }
  if (!preview) return
  const s = summarizePreview(preview)
  if (mode === 'feature') {
    for (const f of FEATURE_COLORS) {
      const mm = s.featureMm[f.id] ?? 0
      if (mm > 0) add(f.color, `${f.label}  ${(mm / 1000).toFixed(1)} m`)
    }
  } else if (mode === 'tool') {
    s.toolMm.forEach((mm, i) => add(toolColors[i] ?? '#888888', `Filament ${i + 1}  ${(mm / 1000).toFixed(1)} m`))
  } else {
    const r = mode === 'speed' ? s.speedRange : mode === 'flow' ? s.flowRange : s.layerTimeRange
    const unit = mode === 'speed' ? 'mm/s' : mode === 'flow' ? 'mm3/s' : 's'
    add(HEAT_RAMP[0] ?? '#000000', `${r[0].toFixed(1)} ${unit}`)
    add(HEAT_RAMP[HEAT_RAMP.length - 1] ?? '#ffffff', `${r[1].toFixed(1)} ${unit}`)
  }
}

async function ensurePreview(): Promise<PreviewBuffers> {
  if (preview) return preview
  const b = await loadPreview()
  preview = b
  vp.setPreview(b)
  hi.max = lo.max = String(b.layerCount - 1)
  hi.value = String(b.layerCount - 1)
  lo.value = '0'
  mv.value = '1000'
  readout()
  legend(($<HTMLSelectElement>('cm').value as ColorMode) ?? 'feature')
  return b
}

async function setMode(mode: 'prepare' | 'preview'): Promise<void> {
  if (mode === 'preview') await ensurePreview()
  vp.setMode(mode)
  for (const el of document.querySelectorAll<HTMLInputElement>('input[name=mode]')) el.checked = el.value === mode
}

for (const el of document.querySelectorAll<HTMLInputElement>('input[name=mode]')) el.addEventListener('change', () => void setMode(el.value as 'prepare' | 'preview'))
$<HTMLSelectElement>('look').addEventListener('change', (e) => vp.setRenderMode((e.target as HTMLSelectElement).value as RenderMode))
$<HTMLInputElement>('oh').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value)
  $('oh-v').textContent = `${v} deg`
  vp.setOverhangAngle(v)
})
$<HTMLInputElement>('print').addEventListener('change', (e) => vp.setPrintLook((e.target as HTMLInputElement).checked, 0.2))
$<HTMLSelectElement>('tool').addEventListener('change', (e) => vp.setTool((e.target as HTMLSelectElement).value as 'select' | 'move' | 'rotate'))
$('arrange').addEventListener('click', () => vp.arrange({ animate: true }))
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) b.addEventListener('click', () => vp.view(b.dataset.view as 'iso' | 'top' | 'front' | 'fit', { animate: true }))
$<HTMLSelectElement>('cm').addEventListener('change', (e) => {
  const m = (e.target as HTMLSelectElement).value as ColorMode
  vp.setColorMode(m)
  legend(m)
})
for (const el of [hi, lo, mv]) el.addEventListener('input', applyRange)
$<HTMLInputElement>('trav').addEventListener('change', (e) => vp.setTravels((e.target as HTMLInputElement).checked))
$('play').addEventListener('click', () => {
  const b = preview
  if (!b) return
  const t0 = performance.now()
  const dur = 2600
  mv.value = '1000'
  const step = (now: number): void => {
    const k = Math.min(b.layerCount - 1, Math.floor(((now - t0) / dur) * b.layerCount))
    hi.value = String(k)
    applyRange()
    if (k < b.layerCount - 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
})

/** Scripted orbit for the benchmark: one full turn around the current target at a fixed elevation. */
function orbit(ms = 10000): Promise<ViewportStats> {
  const start = vp.getCamera()
  vp.setGpuTiming(q.get('timing') !== '0')
  return new Promise((resolve) => {
    let t0 = -1
    const step = (now: number): void => {
      if (t0 < 0) {
        t0 = now
        vp.resetStats()
      }
      const k = (now - t0) / ms
      vp.setCamera({ azimuthDeg: start.azimuthDeg + 360 * Math.min(1, k), elevationDeg: 24 + 8 * Math.sin(k * Math.PI * 2) })
      if (k < 1) requestAnimationFrame(step)
      else {
        const s = vp.stats()
        vp.setGpuTiming(false)
        $('stats').textContent = `p50 ${s.p50.toFixed(2)} ms  p95 ${s.p95.toFixed(2)} ms\n${s.frameMs.length} frames at ${s.width}x${s.height}\n${s.triangles.toLocaleString('en-US')} triangles, ${s.drawCalls} draws\n${s.gpu}`
        resolve(s)
      }
    }
    requestAnimationFrame(step)
  })
}
$('orbit').addEventListener('click', () => void orbit())

const ready = (async () => {
  // In the app the viewport exists long before a slice result; give its shader warm-up that head start here too.
  await new Promise((r) => setTimeout(r, 400))
  if (q.get('mode') === 'preview') await setMode('preview')
  else void ensurePreview().then(() => undefined)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
})()

declare global {
  interface Window {
    sxDemo: { vp: typeof vp; ready: Promise<void>; orbit: typeof orbit; setMode: typeof setMode; preview: () => PreviewBuffers | null }
  }
}
window.sxDemo = { vp, ready, orbit, setMode, preview: () => preview }
