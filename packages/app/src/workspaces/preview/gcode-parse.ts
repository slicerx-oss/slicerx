// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads a G-code file from any slicer into SXPV preview buffers, so a file opened on its own shows in Preview
// with no project. It reads the bytes directly (no string per line), understands G0 to G3 (arcs as chords),
// G90 and G91, M82 and M83, G92, T, M104 and M109, M106 and M107, and the feature, width, height and layer
// comments OrcaSlicer, Bambu Studio, PrusaSlicer and Cura write. Every move keeps its G-code line, so the
// line view and the toolpaths stay linked. File text is untrusted: only numbers come out of it.
import { FEATURE, SXPV_EXTRA_BYTES, SXPV_EXTRA_FLAG, SXPV_FLAG_EXTRAS, SXPV_FLAG_TRAVELS, SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_TRAVEL_BYTES, SXPV_VERSION, readPreview, type PreviewBuffers } from '@slicerx/contracts'
import { wholeSource, windows, yieldToPage, type LineIndex, type LineSource } from './gcode-lines'

const FEATURE_BY_NAME: Record<string, number> = {
  'outer wall': FEATURE.outerWall,
  'external perimeter': FEATURE.outerWall,
  'wall-outer': FEATURE.outerWall,
  'inner wall': FEATURE.innerWall,
  perimeter: FEATURE.innerWall,
  'wall-inner': FEATURE.innerWall,
  'overhang wall': FEATURE.overhangWall,
  'overhang perimeter': FEATURE.overhangWall,
  'top surface': FEATURE.topSurface,
  'top solid infill': FEATURE.topSurface,
  'bottom surface': FEATURE.bottomSurface,
  'internal solid infill': FEATURE.internalSolid,
  'solid infill': FEATURE.internalSolid,
  skin: FEATURE.internalSolid,
  'sparse infill': FEATURE.sparseInfill,
  'internal infill': FEATURE.sparseInfill,
  fill: FEATURE.sparseInfill,
  infill: FEATURE.sparseInfill,
  bridge: FEATURE.bridge,
  'bridge infill': FEATURE.bridge,
  'internal bridge': FEATURE.bridge,
  support: FEATURE.support,
  'support material': FEATURE.support,
  'support interface': FEATURE.supportInterface,
  'support material interface': FEATURE.supportInterface,
  'support transition': FEATURE.supportInterface,
  'support-interface': FEATURE.supportInterface,
  'prime-tower': FEATURE.primeTower,
  brim: FEATURE.brimSkirt,
  skirt: FEATURE.brimSkirt,
  'skirt/brim': FEATURE.brimSkirt,
  ironing: FEATURE.ironing,
  'gap infill': FEATURE.gapFill,
  'gap fill': FEATURE.gapFill,
  'prime tower': FEATURE.primeTower,
  'wipe tower': FEATURE.primeTower,
  custom: FEATURE.custom,
}

/** The SXPV feature id for a slicer's feature comment; anything unknown draws as custom. */
export function featureOf(name: string): number {
  const k = name.trim().toLowerCase().replaceAll('_', ' ')
  return FEATURE_BY_NAME[k] ?? FEATURE.custom
}

/** A byte buffer that doubles when full. */
class Grow {
  buf: ArrayBuffer
  len = 0
  constructor(bytes: number) {
    this.buf = new ArrayBuffer(Math.max(64, bytes))
  }
  reserve(n: number): DataView {
    if (this.len + n > this.buf.byteLength) {
      const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.len + n))
      new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.len))
      this.buf = next
    }
    const v = new DataView(this.buf, this.len, n)
    this.len += n
    return v
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.buf, 0, this.len)
  }
}

const SEMI = 59
const SPACE = 32
const TAB = 9
const CR = 13
const NL = 10
const DOT = 46
const MINUS = 45
const PLUS = 43
const ZERO = 48
const NINE = 57
const UPPER = (c: number) => (c >= 97 && c <= 122 ? c - 32 : c)

const textDecoder = new TextDecoder()

function startsWith(b: Uint8Array, at: number, end: number, ascii: string): boolean {
  if (end - at < ascii.length) return false
  for (let i = 0; i < ascii.length; i++) if (UPPER(b[at + i] ?? 0) !== UPPER(ascii.charCodeAt(i))) return false
  return true
}

/** Number at `at`; `next` holds the index after it. NaN when there is none. */
let next = 0
function num(b: Uint8Array, at: number, end: number): number {
  let i = at
  let sign = 1
  if (b[i] === MINUS) {
    sign = -1
    i++
  } else if (b[i] === PLUS) i++
  let v = 0
  let digits = 0
  while (i < end) {
    const c = b[i] ?? 0
    if (c < ZERO || c > NINE) break
    v = v * 10 + (c - ZERO)
    digits++
    i++
  }
  if (b[i] === DOT) {
    i++
    let scale = 0.1
    while (i < end) {
      const c = b[i] ?? 0
      if (c < ZERO || c > NINE) break
      v += (c - ZERO) * scale
      scale *= 0.1
      digits++
      i++
    }
  }
  next = i
  return digits ? sign * v : NaN
}

export interface ParsedGcode {
  preview: PreviewBuffers
  /** Estimated print time from move lengths and feed rates, no acceleration. */
  timeS: number
  /** Filament length per tool, mm. */
  filamentMm: number[]
}

/** Arc chords are at most this long (mm). */
const ARC_CHORD = 0.5

export async function parseGcodePreview(ix: LineIndex, opts: { signal?: AbortSignal; pause?: () => Promise<void>; linesPerSlice?: number } = {}): Promise<ParsedGcode> {
  const b = ix.bytes
  const pause = opts.pause ?? yieldToPage
  const perSlice = opts.linesPerSlice ?? 150_000
  const segs = new Grow(Math.min(1 << 26, ix.count * 20))
  const extras = new Grow(Math.min(1 << 24, ix.count * 5))
  const travels = new Grow(1 << 16)
  const travelFlags = new Grow(1 << 12)
  const layerStart: number[] = []
  const travelStart: number[] = []
  const layerZ: number[] = []
  const layerTime: number[] = []
  let segCount = 0
  let travelCount = 0

  let absXYZ = true
  let relE = false
  let x = 0, y = 0, z = 0, e = 0
  let feed = 50
  let feature: number = FEATURE.custom
  let tool = 0
  let toolCount = 1
  let fan = 0
  let temp = 0
  let width = 0
  let height = 0
  let filArea = Math.PI * 0.875 * 0.875
  let pendingFlags = 0
  let byComment = false
  let layerAsked = false
  // Extrusion before the first layer comment (a start purge) joins layer 1 instead of making a layer of its own.
  let startLayer = false
  let markerSeen = false
  let timeS = 0
  const filamentMm: number[] = [0]
  // Whether the file marks layers with comments: then a new layer starts at the comment, not at a Z change.
  for (let n = 1; n <= Math.min(ix.count, 20_000) && !byComment; n++) {
    const a = ix.starts[n - 1] ?? 0
    const end = ix.starts[n] ?? a
    if (b[a] !== SEMI) continue
    // Bambu Lab writes "; CHANGE_LAYER" with a space, Orca ";LAYER_CHANGE" without.
    let c = a + 1
    while (c < end && b[c] === SPACE) c++
    if (startsWith(b, c, end, 'LAYER_CHANGE') || startsWith(b, c, end, 'LAYER:') || startsWith(b, c, end, 'CHANGE_LAYER')) byComment = true
  }

  const openLayer = (atZ: number) => {
    layerStart.push(segCount)
    travelStart.push(travelCount)
    layerZ.push(atZ)
    layerTime.push(0)
  }

  const addTravel = (x0: number, y0: number, x1: number, y1: number, flags: number) => {
    if (layerStart.length === 0) return
    const v = travels.reserve(SXPV_TRAVEL_BYTES)
    v.setFloat32(0, x0, true)
    v.setFloat32(4, y0, true)
    v.setFloat32(8, x1, true)
    v.setFloat32(12, y1, true)
    travelFlags.reserve(1).setUint8(0, flags)
    travelCount++
  }

  const addSegment = (x0: number, y0: number, x1: number, y1: number, de: number, line: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (len < 1e-6) return
    const lastZ = layerZ[layerZ.length - 1] ?? -1
    // A layer comment opens the layer at its first extrusion. A purge line before the first comment, at the
    // first layer's height, stays in that layer.
    if (layerAsked && layerStart.length === 1 && Math.abs(z - lastZ) < 1e-4 && layerTime.length === 1) {
      layerAsked = false
      startLayer = false
    }
    if (layerAsked && startLayer) {
      // The first comment after a start purge: the purge's layer becomes the first layer, at the layer's own height.
      startLayer = false
      layerAsked = false
      layerZ[0] = z
    }
    if (byComment && !markerSeen && layerStart.length === 0) startLayer = true
    if (layerStart.length === 0 || (!byComment && z > lastZ + 0.009) || layerAsked) {
      openLayer(z)
      layerAsked = false
    } else if (z > (layerZ[layerZ.length - 1] ?? 0)) layerZ[layerZ.length - 1] = z
    const k = layerZ.length - 1
    const h = height > 0 ? height : Math.max(0.05, z - (layerZ[k - 1] ?? 0))
    const area = (de * filArea) / len
    const w = width > 0 ? width : Math.max(0.1, area / h + h * (1 - Math.PI / 4))
    const speed = Math.max(0.1, feed)
    const v = segs.reserve(SXPV_SEGMENT_BYTES)
    v.setFloat32(0, x0, true)
    v.setFloat32(4, y0, true)
    v.setFloat32(8, x1, true)
    v.setFloat32(12, y1, true)
    v.setFloat32(16, z, true)
    v.setUint16(20, Math.min(65535, Math.round(w * 1000)), true)
    v.setUint16(22, Math.min(65535, Math.round(h * 1000)), true)
    v.setUint8(24, feature)
    v.setUint8(25, tool)
    v.setUint16(26, Math.min(65535, Math.round(speed * 10)), true)
    v.setFloat32(28, (de * filArea) / (len / speed), true)
    const xv = extras.reserve(SXPV_EXTRA_BYTES)
    xv.setUint8(0, Math.round(fan))
    xv.setUint8(1, pendingFlags)
    xv.setUint16(2, temp, true)
    xv.setUint32(4, line, true)
    pendingFlags = 0
    segCount++
  }

  const move = (nx: number, ny: number, nz: number, ne: number, line: number) => {
    const de = ne - e
    const len = Math.hypot(nx - x, ny - y)
    const t = (len > 0 ? len : Math.abs(nz - z)) / Math.max(0.1, feed)
    timeS += t
    if (layerTime.length) layerTime[layerTime.length - 1] = (layerTime[layerTime.length - 1] ?? 0) + t
    if (de > 1e-9 && len > 1e-6) {
      if (nz !== z) z = nz
      addSegment(x, y, nx, ny, de, line)
      filamentMm[tool] = (filamentMm[tool] ?? 0) + de
    } else {
      if (de < -1e-9) pendingFlags |= SXPV_EXTRA_FLAG.retract
      if (nz > z + 1e-4 && len < 1e-6) pendingFlags |= SXPV_EXTRA_FLAG.lift
      if (len > 1e-6) addTravel(x, y, nx, ny, pendingFlags & (SXPV_EXTRA_FLAG.retract | SXPV_EXTRA_FLAG.lift))
      z = nz
    }
    x = nx
    y = ny
    e = ne
  }

  for (let n = 1; n <= ix.count; n++) {
    if (n % perSlice === 0) {
      if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError')
      await pause()
    }
    let i = ix.starts[n - 1] ?? 0
    let end = ix.starts[n] ?? i
    while (end > i && (b[end - 1] === NL || b[end - 1] === CR)) end--
    while (i < end && (b[i] === SPACE || b[i] === TAB)) i++
    if (i >= end) continue
    if (b[i] === SEMI) {
      // Comments: feature, width, height, layer and filament diameter.
      let c = i + 1
      while (c < end && b[c] === SPACE) c++
      if (startsWith(b, c, end, 'TYPE:') || startsWith(b, c, end, 'FEATURE:')) {
        const at = b[c] === 84 || b[c] === 116 ? c + 5 : c + 8
        feature = featureOf(textDecoder.decode(b.subarray(at, Math.min(end, at + 40))))
      } else if (startsWith(b, c, end, 'WIDTH:')) width = num(b, c + 6, end) || 0
      else if (startsWith(b, c, end, 'LINE_WIDTH: ')) width = num(b, c + 12, end) || 0
      else if (startsWith(b, c, end, 'HEIGHT:')) height = num(b, c + 7, end) || 0
      else if (startsWith(b, c, end, 'LAYER_HEIGHT: ')) height = num(b, c + 14, end) || 0
      else if (startsWith(b, c, end, 'LAYER_CHANGE') || startsWith(b, c, end, 'LAYER:') || startsWith(b, c, end, 'CHANGE_LAYER')) {
        layerAsked = byComment
        markerSeen = true
      } else if (startsWith(b, c, end, 'filament_diameter')) {
        let k = c + 17
        while (k < end && (b[k] === SPACE || b[k] === 61 || b[k] === 58)) k++
        const d = num(b, k, end)
        if (d > 0.5 && d < 5) filArea = Math.PI * (d / 2) * (d / 2)
      }
      continue
    }
    const letter = UPPER(b[i] ?? 0)
    const code = num(b, i + 1, end)
    if (Number.isNaN(code)) continue
    // Parameters run to a comment.
    let pEnd = next
    while (pEnd < end && b[pEnd] !== SEMI) pEnd++
    if (letter === 84) {
      // T<n>: tool change.
      tool = Math.max(0, Math.min(63, Math.round(code)))
      toolCount = Math.max(toolCount, tool + 1)
      while (filamentMm.length < toolCount) filamentMm.push(0)
      continue
    }
    let px = NaN, py = NaN, pz = NaN, pe = NaN, pf = NaN, pi = NaN, pj = NaN, ps = NaN
    for (let k = next; k < pEnd; ) {
      const c = UPPER(b[k] ?? 0)
      if (c < 65 || c > 90) {
        k++
        continue
      }
      const v = num(b, k + 1, pEnd)
      k = next > k + 1 ? next : k + 1
      if (c === 88) px = v
      else if (c === 89) py = v
      else if (c === 90) pz = v
      else if (c === 69) pe = v
      else if (c === 70) pf = v
      else if (c === 73) pi = v
      else if (c === 74) pj = v
      else if (c === 83) ps = v
    }
    if (letter === 71) {
      const g = Math.round(code)
      if (g === 0 || g === 1 || g === 2 || g === 3) {
        if (!Number.isNaN(pf) && pf > 0) feed = pf / 60
        const nx = Number.isNaN(px) ? x : absXYZ ? px : x + px
        const ny = Number.isNaN(py) ? y : absXYZ ? py : y + py
        const nz = Number.isNaN(pz) ? z : absXYZ ? pz : z + pz
        const ne = Number.isNaN(pe) ? e : relE ? e + pe : pe
        if ((g === 2 || g === 3) && !(Number.isNaN(pi) && Number.isNaN(pj))) {
          // An arc around (x + I, y + J), as chords.
          const cx = x + (Number.isNaN(pi) ? 0 : pi)
          const cy = y + (Number.isNaN(pj) ? 0 : pj)
          const r = Math.hypot(x - cx, y - cy)
          const a0 = Math.atan2(y - cy, x - cx)
          let a1 = Math.atan2(ny - cy, nx - cx)
          if (g === 2 && a1 >= a0) a1 -= 2 * Math.PI
          if (g === 3 && a1 <= a0) a1 += 2 * Math.PI
          const steps = Math.max(1, Math.min(256, Math.ceil((Math.abs(a1 - a0) * r) / ARC_CHORD)))
          const e0 = e
          const z0 = z
          for (let s = 1; s <= steps; s++) {
            const f = s / steps
            const a = a0 + (a1 - a0) * f
            const last = s === steps
            move(last ? nx : cx + r * Math.cos(a), last ? ny : cy + r * Math.sin(a), z0 + (nz - z0) * f, e0 + (ne - e0) * f, n)
          }
        } else move(nx, ny, nz, ne, n)
      } else if (g === 90) absXYZ = true
      else if (g === 91) absXYZ = false
      else if (g === 92) {
        if (!Number.isNaN(pe)) e = pe
        if (!Number.isNaN(px)) x = px
        if (!Number.isNaN(py)) y = py
        if (!Number.isNaN(pz)) z = pz
      } else if (g === 10) pendingFlags |= SXPV_EXTRA_FLAG.retract
    } else if (letter === 77) {
      const m = Math.round(code)
      if (m === 82) relE = false
      else if (m === 83) relE = true
      else if (m === 106) fan = Number.isNaN(ps) ? 255 : Math.max(0, Math.min(255, ps))
      else if (m === 107) fan = 0
      else if ((m === 104 || m === 109) && !Number.isNaN(ps)) temp = Math.max(0, Math.min(65535, Math.round(ps)))
    }
  }

  const N = layerZ.length
  layerStart.push(segCount)
  travelStart.push(travelCount)
  const flags = SXPV_FLAG_TRAVELS | SXPV_FLAG_EXTRAS
  const tablesBytes = (N + 1) * 4 + N * 4 + N * 4 + (N + 1) * 4
  let size = SXPV_HEADER_BYTES + tablesBytes + segCount * SXPV_SEGMENT_BYTES + travelCount * SXPV_TRAVEL_BYTES + segCount * SXPV_EXTRA_BYTES + travelCount
  size = (size + 3) & ~3
  const raw = new ArrayBuffer(size)
  const h = new DataView(raw)
  h.setUint32(0, SXPV_MAGIC, true)
  h.setUint16(4, SXPV_VERSION, true)
  h.setUint16(6, flags, true)
  h.setUint32(8, segCount, true)
  h.setUint32(12, N, true)
  h.setUint32(16, travelCount, true)
  h.setUint32(20, toolCount, true)
  let typical = 0
  for (let k = 1; k < N; k++) typical = Math.max(typical, Math.min(1, (layerZ[k] ?? 0) - (layerZ[k - 1] ?? 0)))
  h.setFloat32(24, N > 1 ? Math.min(typical, (layerZ[1] ?? 0) - (layerZ[0] ?? 0) || typical) : (layerZ[0] ?? 0.2), true)
  let o = SXPV_HEADER_BYTES
  new Uint32Array(raw, o, N + 1).set(layerStart)
  o += (N + 1) * 4
  new Float32Array(raw, o, N).set(layerZ)
  o += N * 4
  new Float32Array(raw, o, N).set(layerTime)
  o += N * 4
  new Uint32Array(raw, o, N + 1).set(travelStart)
  o += (N + 1) * 4
  const out = new Uint8Array(raw)
  out.set(segs.bytes(), o)
  o += segCount * SXPV_SEGMENT_BYTES
  out.set(travels.bytes(), o)
  o += travelCount * SXPV_TRAVEL_BYTES
  out.set(extras.bytes(), o)
  o += segCount * SXPV_EXTRA_BYTES
  out.set(travelFlags.bytes(), o)
  return { preview: readPreview(raw), timeS, filamentMm }
}

/** A marker in the G-code: its line (1-based) and where the nozzle is when it runs, bed frame mm. */
export interface GcodeMark {
  line: number
  x: number
  y: number
  z: number
}

/** Where the file asks for a wipe, a tool or filament change, or a pause. */
export interface GcodeMarks {
  wipes: GcodeMark[]
  toolChanges: GcodeMark[]
  pauses: GcodeMark[]
}

/**
 * The wipes (`;WIPE_START`), tool changes (a `T` that picks another tool after the first, and `M600` filament
 * changes) and pauses (`M601`, `M0`, `M1`, `M25`, `PAUSE`, `@pause`), with the nozzle position at each. Moves are
 * followed in G90 and G91 and through G92, so a marker sits where the printer is when the command runs. Walked
 * in slices like the parse.
 */
export async function scanMarks(text: LineIndex | LineSource, opts: { signal?: AbortSignal; pause?: () => Promise<void>; linesPerSlice?: number } = {}): Promise<GcodeMarks> {
  const src = 'window' in text ? text : wholeSource(text)
  const pause = opts.pause ?? yieldToPage
  const perSlice = opts.linesPerSlice ?? 200_000
  const out: GcodeMarks = { wipes: [], toolChanges: [], pauses: [] }
  let tool = -1
  let abs = true
  let x = 0
  let y = 0
  let z = 0
  // A window of lines at a time: the text can be read from the host that keeps it, and none of it stays here.
  for await (const [w, from, to] of windows(src, perSlice)) {
    if (from > 1) {
      if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError')
      await pause()
    }
    const b = w.bytes
    const base = w.base ?? 0
    for (let n = from; n <= to; n++) {
      let i = (w.starts[n - 1] ?? 0) - base
      const end = (w.starts[n] ?? 0) - base
      while (i < end && (b[i] === SPACE || b[i] === TAB)) i++
      const c = UPPER(b[i] ?? 0)
      if (c === 71) {
        const g = num(b, i + 1, end)
        if (g === 90) abs = true
        else if (g === 91) abs = false
        else if (g === 0 || g === 1 || g === 2 || g === 3 || g === 92) {
          for (let k = next; k < end && b[k] !== SEMI; ) {
            const p = UPPER(b[k] ?? 0)
            if (p !== 88 && p !== 89 && p !== 90) {
              k++
              continue
            }
            const v = num(b, k + 1, end)
            k = next > k + 1 ? next : k + 1
            if (Number.isNaN(v)) continue
            if (p === 88) x = g === 92 || abs ? v : x + v
            else if (p === 89) y = g === 92 || abs ? v : y + v
            else z = g === 92 || abs ? v : z + v
          }
        }
      } else if (c === SEMI) {
        if (startsWith(b, i + 1, end, 'WIPE_START')) out.wipes.push({ line: n, x, y, z })
      } else if (c === 84) {
        const t = num(b, i + 1, end)
        if (Number.isNaN(t) || t > 255) continue
        if (tool >= 0 && t !== tool) out.toolChanges.push({ line: n, x, y, z })
        tool = t
      } else if (c === 77) {
        const m = num(b, i + 1, end)
        const after = b[next] ?? NL
        if (!(after === SPACE || after === TAB || after === SEMI || after === NL || after === CR || next >= end)) continue
        if (m === 600) out.toolChanges.push({ line: n, x, y, z })
        else if (m === 601 || m === 0 || m === 1 || m === 25) out.pauses.push({ line: n, x, y, z })
      } else if (c === 80 || c === 64) {
        if (startsWith(b, i, end, 'PAUSE') || startsWith(b, i, end, '@pause')) out.pauses.push({ line: n, x, y, z })
      }
    }
  }
  return out
}
