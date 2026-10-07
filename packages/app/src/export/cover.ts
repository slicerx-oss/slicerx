// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cover picture for a Vault upload, drawn from the model's own triangles as a
// shop drawing: true isometric line art, hidden edges dashed, the overall size
// dimensioned in mm, on a 10 mm grid. One fixed camera and fit rule, so every
// card lines up. Pure code on typed arrays with its own stroke font, so it
// works without the viewport, in a worker and in Node.

export interface CoverMesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
  /** The filament color, #rrggbb. Empty or unreadable picks from COVER_COLORS by slot. */
  color: string
  /** 1-based filament slot, for the fallback color. */
  slot?: number
  /** 4x4 column-major placement, mm. */
  transform?: ArrayLike<number>
}

export interface CoverImage {
  width: number
  height: number
  rgba: Uint8ClampedArray
}

export interface CoverOptions {
  /** Ground and ink colors. Vault covers use dark so every card matches. */
  theme?: 'dark' | 'light'
}

import { COVER_PROFILE, isoView } from './cover-profile'

export { COVER_PROFILE, isoView } from './cover-profile'

type V3 = [number, number, number]

interface Palette {
  paper: V3
  grid: V3
  ink: V3
  hidden: V3
  dim: V3
}

const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: { paper: rgb('#262833'), grid: rgb('#5d6180'), ink: rgb('#f8f8f2'), hidden: rgb('#8f9abb'), dim: rgb('#bd93f9') },
  light: { paper: rgb('#f7f6f3'), grid: rgb('#a7a2b5'), ink: rgb('#2a2833'), hidden: rgb('#6b6874'), dim: rgb('#7349c9') },
}

/** Fill colors for a file that names none, by filament slot. */
export const COVER_COLORS = ['#bd93f9', '#ff79c6', '#8be9fd', '#50fa7b', '#fab570', '#efefe9'] as const

/** The fill a mesh is drawn in: its own color, or the slot's fallback. */
export function coverColor(color: string | undefined, slot = 1): string {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec((color ?? '').trim())
  return m ? `#${m[1]!.toLowerCase()}` : COVER_COLORS[(Math.max(1, Math.floor(slot)) - 1) % COVER_COLORS.length]!
}

function rgb(c: string): V3 {
  const n = parseInt(coverColor(c).slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function place(t: ArrayLike<number> | undefined, x: number, y: number, z: number): V3 {
  if (!t) return [x, y, z]
  return [
    (t[0] ?? 1) * x + (t[4] ?? 0) * y + (t[8] ?? 0) * z + (t[12] ?? 0),
    (t[1] ?? 0) * x + (t[5] ?? 1) * y + (t[9] ?? 0) * z + (t[13] ?? 0),
    (t[2] ?? 0) * x + (t[6] ?? 0) * y + (t[10] ?? 1) * z + (t[14] ?? 0),
  ]
}

/** Overall size label: whole mm from 10 up, one decimal below. */
export function mmLabel(v: number): string {
  return v >= 10 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString()
}

const CY = Math.cos((COVER_PROFILE.yawDeg * Math.PI) / 180)
const SY = Math.sin((COVER_PROFILE.yawDeg * Math.PI) / 180)
const CE = Math.cos((COVER_PROFILE.elevDeg * Math.PI) / 180)
const SE = Math.sin((COVER_PROFILE.elevDeg * Math.PI) / 180)

/** View x, y back to the world point on the plane z = h. */
function onPlane(vx: number, vy: number, h: number): [number, number] {
  const y1 = (vy - h * CE) / SE
  return [vx * CY + y1 * SY, -vx * SY + y1 * CY]
}

interface Fit {
  s: number
  ox: number
  oy: number
}

function screen(f: Fit, x: number, y: number, z: number): V3 {
  const v = isoView(x, y, z)
  return [f.ox + v[0] * f.s, f.oy - v[1] * f.s, v[2]]
}

// ---- model

interface Model {
  /** welded positions, centered across with the base at z = 0 */
  P: Float64Array
  T: Uint32Array
  N: Float32Array
  part: Uint16Array
  colors: V3[]
  size: V3
  nv: number
  nt: number
}

function build(meshes: readonly CoverMesh[]): Model | null {
  // place and weld, so triangle soup (STL) still shares its edges
  const pos: number[] = []
  const tri: number[] = []
  const part: number[] = []
  const colors: V3[] = []
  meshes.forEach((m, k) => {
    colors.push(rgb(coverColor(m.color, m.slot)))
    const weld = new Map<string, number>()
    const map: number[] = []
    for (let i = 0; i + 2 < m.positions.length; i += 3) {
      const p = place(m.transform, m.positions[i] ?? 0, m.positions[i + 1] ?? 0, m.positions[i + 2] ?? 0)
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
        map.push(-1)
        continue
      }
      const key = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`
      let id = weld.get(key)
      if (id === undefined) {
        id = pos.length / 3
        pos.push(p[0], p[1], p[2])
        weld.set(key, id)
      }
      map.push(id)
    }
    for (let i = 0; i + 2 < m.indices.length; i += 3) {
      const a = map[m.indices[i] ?? -1] ?? -1
      const b = map[m.indices[i + 1] ?? -1] ?? -1
      const c = map[m.indices[i + 2] ?? -1] ?? -1
      if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue
      tri.push(a, b, c)
      part.push(k)
    }
  })
  const nv = pos.length / 3
  const nt = tri.length / 3
  if (nt === 0) return null
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const t of tri) {
    for (let a = 0; a < 3; a++) {
      const v = pos[t * 3 + a]!
      if (v < lo[a]!) lo[a] = v
      if (v > hi[a]!) hi[a] = v
    }
  }
  const P = Float64Array.from(pos)
  const cx = (lo[0] + hi[0]) / 2
  const cy = (lo[1] + hi[1]) / 2
  for (let i = 0; i < nv; i++) {
    P[i * 3] = P[i * 3]! - cx
    P[i * 3 + 1] = P[i * 3 + 1]! - cy
    P[i * 3 + 2] = P[i * 3 + 2]! - lo[2]
  }
  const T = Uint32Array.from(tri)
  const N = new Float32Array(nt * 3)
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3]! * 3
    const b = T[t * 3 + 1]! * 3
    const c = T[t * 3 + 2]! * 3
    const ux = P[b]! - P[a]!
    const uy = P[b + 1]! - P[a + 1]!
    const uz = P[b + 2]! - P[a + 2]!
    const wx = P[c]! - P[a]!
    const wy = P[c + 1]! - P[a + 1]!
    const wz = P[c + 2]! - P[a + 2]!
    const nx = uy * wz - uz * wy
    const ny = uz * wx - ux * wz
    const nz = ux * wy - uy * wx
    const l = Math.hypot(nx, ny, nz) || 1
    N[t * 3] = nx / l
    N[t * 3 + 1] = ny / l
    N[t * 3 + 2] = nz / l
  }
  return { P, T, N, part: Uint16Array.from(part), colors, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], nv, nt }
}

/** Scale so the projected part fills the fit share of the frame, centered across, base line at `base`. */
function fitOf(m: Model, W: number, H: number): Fit {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (let i = 0; i < m.nv; i++) {
    const v = isoView(m.P[i * 3]!, m.P[i * 3 + 1]!, m.P[i * 3 + 2]!)
    if (v[0] < x0) x0 = v[0]
    if (v[0] > x1) x1 = v[0]
    if (v[1] < y0) y0 = v[1]
    if (v[1] > y1) y1 = v[1]
  }
  const s = Math.min((W * COVER_PROFILE.fitWidth) / Math.max(1e-6, x1 - x0), (H * COVER_PROFILE.fitHeight) / Math.max(1e-6, y1 - y0))
  return { s, ox: W / 2 - ((x0 + x1) / 2) * s, oy: H * COVER_PROFILE.base + y0 * s }
}

interface GBuffer {
  depth: Float32Array
  tri: Int32Array
}

function raster(m: Model, f: Fit, W: number, H: number): GBuffer {
  const depth = new Float32Array(W * H).fill(-Infinity)
  const tri = new Int32Array(W * H).fill(-1)
  const S = new Float64Array(m.nv * 3)
  for (let i = 0; i < m.nv; i++) {
    const p = screen(f, m.P[i * 3]!, m.P[i * 3 + 1]!, m.P[i * 3 + 2]!)
    S[i * 3] = p[0]
    S[i * 3 + 1] = p[1]
    S[i * 3 + 2] = p[2]
  }
  for (let t = 0; t < m.nt; t++) {
    const ia = m.T[t * 3]! * 3
    const ib = m.T[t * 3 + 1]! * 3
    const ic = m.T[t * 3 + 2]! * 3
    const ax = S[ia]!
    const ay = S[ia + 1]!
    const az = S[ia + 2]!
    const bx = S[ib]!
    const by = S[ib + 1]!
    const bz = S[ib + 2]!
    const cx = S[ic]!
    const cy = S[ic + 1]!
    const cz = S[ic + 2]!
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(area) < 1e-9) continue
    const xa = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const xb = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)))
    const ya = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const yb = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)))
    for (let y = ya; y <= yb; y++) {
      const py = y + 0.5
      for (let x = xa; x <= xb; x++) {
        const px = x + 0.5
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area
        const w2 = 1 - w0 - w1
        if (w0 < 0 || w1 < 0 || w2 < 0) continue
        const z = w0 * az + w1 * bz + w2 * cz
        const i = y * W + x
        if (z <= depth[i]!) continue
        depth[i] = z
        tri[i] = t
      }
    }
  }
  return { depth, tri }
}

// ---- drawing into coverage buffers (0..1 per pixel)

/** Soft round-capped segment, coverage by distance, kept as the max. */
function segment(buf: Float32Array, W: number, H: number, x0: number, y0: number, x1: number, y1: number, r: number): void {
  const xa = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1))
  const xb = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + r + 1))
  const ya = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1))
  const yb = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + r + 1))
  const dx = x1 - x0
  const dy = y1 - y0
  const ll = dx * dx + dy * dy
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const px = x + 0.5 - x0
      const py = y + 0.5 - y0
      const t = ll > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / ll)) : 0
      const d = Math.hypot(px - t * dx, py - t * dy)
      const c = r + 0.5 - d
      if (c <= 0) continue
      const i = y * W + x
      const v = c > 1 ? 1 : c
      if (v > buf[i]!) buf[i] = v
    }
  }
}

/** Fills a convex quad (corners in order). */
function quad(buf: Float32Array, W: number, H: number, q: readonly [number, number][]): void {
  const xs = q.map((p) => p[0])
  const ys = q.map((p) => p[1])
  const xa = Math.max(0, Math.floor(Math.min(...xs)))
  const xb = Math.min(W - 1, Math.ceil(Math.max(...xs)))
  const ya = Math.max(0, Math.floor(Math.min(...ys)))
  const yb = Math.min(H - 1, Math.ceil(Math.max(...ys)))
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      let pos = 0
      let neg = 0
      for (let k = 0; k < q.length; k++) {
        const a = q[k]!
        const b = q[(k + 1) % q.length]!
        const c = (b[0] - a[0]) * (y + 0.5 - a[1]) - (b[1] - a[1]) * (x + 0.5 - a[0])
        if (c > 0) pos++
        else if (c < 0) neg++
      }
      if (pos === 0 || neg === 0) buf[y * W + x] = 1
    }
  }
}

// ---- stroke font: digits, point, m and x. Units: cap height 1, y down.

type Stroke = [number, number][]

function arc(cx: number, cy: number, r: number, from: number, to: number): Stroke {
  const n = Math.max(4, Math.ceil(Math.abs(to - from) / 15))
  const out: Stroke = []
  for (let i = 0; i <= n; i++) {
    const a = ((from + ((to - from) * i) / n) * Math.PI) / 180
    out.push([cx + r * Math.cos(a), cy - r * Math.sin(a)])
  }
  return out
}

const SIX: Stroke[] = [arc(0.3, 0.7, 0.3, 0, 360), arc(0.62, 0.62, 0.62, 180, 100)]

const GLYPHS: Record<string, { w: number; s: Stroke[] }> = {
  '0': { w: 0.6, s: [[...arc(0.3, 0.3, 0.3, 180, 0), ...arc(0.3, 0.7, 0.3, 0, -180), [0, 0.3]]] },
  '1': { w: 0.6, s: [[[0.1, 0.22], [0.36, 0], [0.36, 1]]] },
  '2': { w: 0.6, s: [[...arc(0.3, 0.28, 0.28, 160, -30), [0, 1], [0.6, 1]]] },
  '3': { w: 0.6, s: [arc(0.3, 0.26, 0.26, 150, -90), arc(0.3, 0.73, 0.27, 90, -150)] },
  '4': { w: 0.6, s: [[[0.46, 1], [0.46, 0], [0, 0.7], [0.62, 0.7]]] },
  '5': { w: 0.6, s: [[[0.56, 0], [0.08, 0], [0.05, 0.46], ...arc(0.3, 0.68, 0.31, 128, -145)]] },
  '6': { w: 0.6, s: SIX },
  '7': { w: 0.6, s: [[[0, 0], [0.6, 0], [0.18, 1]]] },
  '8': { w: 0.6, s: [arc(0.3, 0.25, 0.25, 0, 360), arc(0.3, 0.72, 0.28, 0, 360)] },
  '9': { w: 0.6, s: SIX.map((st) => st.map(([x, y]) => [0.6 - x, 1 - y] as [number, number])) },
  '.': { w: 0.16, s: [[[0.08, 0.98]]] },
  m: { w: 0.72, s: [[[0, 1], [0, 0.42]], [[0, 0.62], ...arc(0.18, 0.62, 0.18, 180, 0), [0.36, 1]], [[0.36, 0.62], ...arc(0.54, 0.62, 0.18, 180, 0), [0.72, 1]]] },
  x: { w: 0.5, s: [[[0, 0.42], [0.5, 1]], [[0.5, 0.42], [0, 1]]] },
  ' ': { w: 0.3, s: [] },
}
const TRACK = 0.24

/** Glyph scale per character: the unit after the space is drawn smaller, on the same baseline. */
const UNIT = 0.62
function scales(s: string): number[] {
  const at = s.indexOf(' ')
  return [...s].map((_, i) => (at >= 0 && i > at ? UNIT : 1))
}

function textWidth(s: string): number {
  const k = scales(s)
  let w = 0
  ;[...s].forEach((ch, i) => (w += ((GLYPHS[ch]?.w ?? 0.4) + TRACK) * k[i]!))
  return Math.max(0, w - TRACK * (k[k.length - 1] ?? 1))
}

/** Strokes `s` centered on (cx, cy), turned by `ang`, `size` px cap height. */
function text(buf: Float32Array, W: number, H: number, s: string, cx: number, cy: number, ang: number, size: number, r: number): void {
  const ca = Math.cos(ang)
  const sa = Math.sin(ang)
  const ks = scales(s)
  let x = -textWidth(s) / 2
  let k = 1
  const map = (p: [number, number]): [number, number] => {
    const u = (x + p[0] * k) * size
    const v = (1 - (1 - p[1]) * k - 0.5) * size
    return [cx + u * ca - v * sa, cy + u * sa + v * ca]
  }
  ;[...s].forEach((ch, i) => {
    k = ks[i]!
    const g = GLYPHS[ch]
    const rr = r * (0.75 + 0.25 * k)
    for (const st of g?.s ?? []) {
      if (st.length === 1) {
        const a = map(st[0]!)
        segment(buf, W, H, a[0], a[1], a[0], a[1], rr * 1.2)
      }
      for (let j = 0; j + 1 < st.length; j++) {
        const a = map(st[j]!)
        const b = map(st[j + 1]!)
        segment(buf, W, H, a[0], a[1], b[0], b[1], rr)
      }
    }
    x += ((g?.w ?? 0.4) + TRACK) * k
  })
}

// ---- passes

function ground(buf: Float32Array, W: number, H: number, f: Fit, pal: Palette, ss: number): void {
  // the grid steps up from 10 mm only when 10 mm squares would be too small to read
  let minor: number = COVER_PROFILE.gridMm
  while (minor * f.s < 7 * ss && minor < 1e5) minor *= 10
  const major = minor * 5
  const lw = Math.min(1.4 * ss, Math.max(0.7, f.s * 0.1))
  const dpx = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) * step * f.s
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [gx, gy] = onPlane((x + 0.5 - f.ox) / f.s, (f.oy - y - 0.5) / f.s, 0)
      const fade = Math.max(0, 1 - Math.hypot((x - W / 2) / (0.62 * W), (y - H * 0.6) / (0.62 * H)))
      const a =
        (Math.max(0, 1 - Math.min(dpx(gx, minor), dpx(gy, minor)) / lw) * 0.3 + Math.max(0, 1 - Math.min(dpx(gx, major), dpx(gy, major)) / (lw * 1.3)) * 0.34) *
        Math.min(1, fade * 1.6)
      const o = (y * W + x) * 3
      for (let c = 0; c < 3; c++) buf[o + c] = pal.paper[c]! + (pal.grid[c]! - pal.paper[c]!) * a
    }
  }
}

function blend(buf: Float32Array, cov: Float32Array, col: V3, k = 1): void {
  for (let i = 0; i < cov.length; i++) {
    const a = cov[i]! * k
    if (a <= 0) continue
    const o = i * 3
    for (let c = 0; c < 3; c++) buf[o + c] = buf[o + c]! + (col[c]! - buf[o + c]!) * a
  }
}

/** Edges worth drawing as vertex pairs: creases over 20 degrees, silhouettes and open edges. */
function edges(m: Model): number[] {
  const key = new Map<number, number>()
  const ea: number[] = []
  const eb: number[] = []
  const f1: number[] = []
  const f2: number[] = []
  const cnt: number[] = []
  for (let t = 0; t < m.nt; t++) {
    for (let e = 0; e < 3; e++) {
      let a = m.T[t * 3 + e]!
      let b = m.T[t * 3 + ((e + 1) % 3)]!
      if (a > b) [a, b] = [b, a]
      const k = a * m.nv + b
      const id = key.get(k)
      if (id === undefined) {
        key.set(k, ea.length)
        ea.push(a)
        eb.push(b)
        f1.push(t)
        f2.push(-1)
        cnt.push(1)
      } else {
        if (cnt[id] === 1) f2[id] = t
        cnt[id] = cnt[id]! + 1
      }
    }
  }
  const front = (t: number) => isoView(m.N[t * 3]!, m.N[t * 3 + 1]!, m.N[t * 3 + 2]!)[2] > 0
  const out: number[] = []
  for (let i = 0; i < ea.length; i++) {
    let draw = cnt[i] !== 2
    if (!draw) {
      const a = f1[i]! * 3
      const b = f2[i]! * 3
      const dot = m.N[a]! * m.N[b]! + m.N[a + 1]! * m.N[b + 1]! + m.N[a + 2]! * m.N[b + 2]!
      draw = dot < 0.94 || front(f1[i]!) !== front(f2[i]!)
    }
    if (draw) out.push(ea[i]!, eb[i]!)
  }
  return out
}

/** Renders the meshes at width by height. Empty input gives just the ground. */
export function renderCover(meshes: readonly CoverMesh[], width = 800, height = 600, opts: CoverOptions = {}): CoverImage {
  const pal = PALETTES[opts.theme ?? 'dark']
  const ss = 2
  const W = width * ss
  const H = height * ss
  const m = build(meshes)
  const buf = new Float32Array(W * H * 3)
  if (!m) {
    ground(buf, W, H, { s: W / 130, ox: W / 2, oy: H * COVER_PROFILE.base }, pal, ss)
    return downsample(buf, W, H, ss)
  }
  const f = fitOf(m, W, H)
  ground(buf, W, H, f, pal, ss)
  const G = raster(m, f, W, H)

  // three flat tones by face direction, the part color washed into the paper
  for (let i = 0; i < W * H; i++) {
    const t = G.tri[i]!
    if (t < 0) continue
    const nz = m.N[t * 3 + 2]!
    const vx = isoView(m.N[t * 3]!, m.N[t * 3 + 1]!, 0)[0]
    const a = nz > 0.5 ? 0.14 : nz < -0.5 ? 0.42 : vx < 0 ? 0.24 : 0.34
    const col = m.colors[m.part[t]!] ?? pal.dim
    const o = i * 3
    for (let c = 0; c < 3; c++) buf[o + c] = pal.paper[c]! + (col[c]! - pal.paper[c]!) * a
  }

  // edges: visible in ink, hidden ones dashed and faint
  const scale = width / 400
  const rv = Math.max(0.9, 0.6 * ss * Math.max(1, scale * 0.9))
  const rh = rv * 0.6
  const eps = (2.5 * ss) / f.s
  const dash = 7 * ss * Math.max(1, scale * 0.6)
  const V = new Float32Array(W * H)
  const Hd = new Float32Array(W * H)
  const list = m.nt > 1_500_000 ? null : edges(m)
  if (list) {
    // dense meshes skip hidden lines, which would only add noise
    const showHidden = list.length / 2 < 6000
    for (let e = 0; e < list.length; e += 2) {
      const ia = list[e]! * 3
      const ib = list[e + 1]! * 3
      const A = screen(f, m.P[ia]!, m.P[ia + 1]!, m.P[ia + 2]!)
      const B = screen(f, m.P[ib]!, m.P[ib + 1]!, m.P[ib + 2]!)
      const L = Math.hypot(B[0] - A[0], B[1] - A[1])
      const steps = Math.max(1, Math.ceil(L * 2))
      let run: { x: number; y: number; vis: boolean } | null = null
      for (let k = 0; k <= steps; k++) {
        const t = k / steps
        const x = A[0] + (B[0] - A[0]) * t
        const y = A[1] + (B[1] - A[1]) * t
        const d = A[2] + (B[2] - A[2]) * t
        const ix = Math.floor(x)
        const iy = Math.floor(y)
        if (ix < 0 || iy < 0 || ix >= W || iy >= H) {
          run = null
          continue
        }
        const vis = d >= G.depth[iy * W + ix]! - eps
        if (!vis && (!showHidden || (t * L) % dash > dash * 0.58)) {
          run = null
          continue
        }
        const from = run && run.vis === vis ? run : { x, y }
        segment(vis ? V : Hd, W, H, from.x, from.y, x, y, vis ? rv : rh)
        run = { x, y, vis }
      }
    }
  } else {
    // very large meshes: the outline from the coverage alone
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        if (G.tri[i]! < 0) continue
        if (G.tri[i - 1]! < 0 || G.tri[i + 1]! < 0 || G.tri[i - W]! < 0 || G.tri[i + W]! < 0) segment(V, W, H, x + 0.5, y + 0.5, x + 0.5, y + 0.5, rv)
      }
    }
  }
  for (let i = 0; i < V.length; i++) if (V[i]! > 0) Hd[i] = Math.max(0, Hd[i]! - V[i]!)
  blend(buf, Hd, pal.hidden, 0.7)
  blend(buf, V, pal.ink)

  dims(buf, W, H, m, f, pal, width, ss)
  return downsample(buf, W, H, ss)
}

/** The size labels a cover carries: width (x), depth (y) and height (z). No height label for a flat part. */
export function coverLabels(size: readonly [number, number, number]): string[] {
  const out = [`${mmLabel(size[0])} mm`, `${mmLabel(size[1])} mm`]
  if (size[2] > 0.5) out.push(`${mmLabel(size[2])} mm`)
  return out
}

/** The overall width, depth and height, drawn as dimension lines in mm. */
function dims(buf: Float32Array, W: number, H: number, m: Model, f: Fit, pal: Palette, width: number, ss: number): void {
  const [sx, sy, sz] = m.size
  const x0 = -sx / 2
  const x1 = sx / 2
  const y0 = -sy / 2
  const y1 = sy / 2
  const S = (x: number, y: number, z: number) => screen(f, x, y, z)
  // the base corner nearest the camera
  let best = { x: x0, y: y0, d: -Infinity }
  for (const x of [x0, x1]) {
    for (const y of [y0, y1]) {
      const p = S(x, y, 0)
      if (p[2] > best.d) best = { x, y, d: p[2] }
    }
  }
  const off = Math.max(sx, sy, sz) * 0.12 + 2
  const fs = Math.max(9 * ss, Math.round((width / 23) * ss))
  const lr = Math.max(0.5 * ss, ((width / 420) * ss) / 2)
  const lines = new Float32Array(W * H)
  const boxes = new Float32Array(W * H)
  const glyphs = new Float32Array(W * H)
  const line = (p: readonly number[], q: readonly number[]) => segment(lines, W, H, p[0]!, p[1]!, q[0]!, q[1]!, lr)
  const dim = (a: V3, b: V3, oa: readonly number[], ob: readonly number[], label: string) => {
    const gap = 0.12
    line([a[0] + (oa[0]! - a[0]) * gap, a[1] + (oa[1]! - a[1]) * gap], [oa[0]! + (oa[0]! - a[0]) * 0.25, oa[1]! + (oa[1]! - a[1]) * 0.25])
    line([b[0] + (ob[0]! - b[0]) * gap, b[1] + (ob[1]! - b[1]) * gap], [ob[0]! + (ob[0]! - b[0]) * 0.25, ob[1]! + (ob[1]! - b[1]) * 0.25])
    line(oa, ob)
    const L = Math.hypot(ob[0]! - oa[0]!, ob[1]! - oa[1]!) || 1
    const u = [(ob[0]! - oa[0]!) / L, (ob[1]! - oa[1]!) / L] as const
    const k = fs * 0.28
    // architectural ticks at both ends
    for (const p of [oa, ob]) line([p[0]! - (u[0] - u[1]) * k, p[1]! - (u[1] + u[0]) * k], [p[0]! + (u[0] - u[1]) * k, p[1]! + (u[1] + u[0]) * k])
    let ang = Math.atan2(u[1], u[0])
    if (ang > Math.PI / 2) ang -= Math.PI
    if (ang < -Math.PI / 2) ang += Math.PI
    const cap = fs * 0.72
    const hw = (textWidth(label) * cap + fs * 0.6) / 2
    const hh = fs * 0.62
    // a label wider than its line sits past the far end, as on a drawing
    const fits = 2 * hw < L - 3 * k
    const mx = fits ? (oa[0]! + ob[0]!) / 2 : ob[0]! + u[0] * (hw + k)
    const my = fits ? (oa[1]! + ob[1]!) / 2 : ob[1]! + u[1] * (hw + k)
    const ca = Math.cos(ang)
    const sa = Math.sin(ang)
    const corner = (cu: number, cv: number): [number, number] => [mx + cu * ca - cv * sa, my + cu * sa + cv * ca]
    quad(boxes, W, H, [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)])
    text(glyphs, W, H, label, mx, my, ang, cap, Math.max(0.55 * ss, cap * 0.075))
  }
  const labels = coverLabels(m.size)
  const ys = best.y
  const sgnY = ys < 0 ? -1 : 1
  dim(S(x0, ys, 0), S(x1, ys, 0), S(x0, ys + sgnY * off, 0), S(x1, ys + sgnY * off, 0), labels[0]!)
  const xs = best.x
  const sgnX = xs < 0 ? -1 : 1
  dim(S(xs, y0, 0), S(xs, y1, 0), S(xs + sgnX * off, y0, 0), S(xs + sgnX * off, y1, 0), labels[1]!)
  // height on the left-most vertical edge
  if (labels[2]) {
    let left = { x: x0, y: y0, px: Infinity }
    for (const x of [x0, x1]) {
      for (const y of [y0, y1]) {
        const p = S(x, y, 0)
        if (p[0] < left.px) left = { x, y, px: p[0] }
      }
    }
    const a = S(left.x, left.y, 0)
    const b = S(left.x, left.y, sz)
    const d = off * f.s * 0.8
    dim(a, b, [a[0] - d, a[1]], [b[0] - d, b[1]], labels[2])
  }
  blend(buf, lines, pal.dim)
  blend(buf, boxes, pal.paper)
  blend(buf, glyphs, pal.dim)
}

function downsample(buf: Float32Array, W: number, H: number, ss: number): CoverImage {
  const w = Math.floor(W / ss)
  const h = Math.floor(H / ss)
  const rgba = new Uint8ClampedArray(w * h * 4)
  const k = 1 / (ss * ss)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const p = ((y * ss + j) * W + x * ss + i) * 3
          r += buf[p]!
          g += buf[p + 1]!
          b += buf[p + 2]!
        }
      }
      const q = (y * w + x) * 4
      rgba[q] = Math.round(r * k * 255)
      rgba[q + 1] = Math.round(g * k * 255)
      rgba[q + 2] = Math.round(b * k * 255)
      rgba[q + 3] = 255
    }
  }
  return { width: w, height: h, rgba }
}

/** Triangles from a binary or ASCII STL, for a cover. Null when the bytes are not an STL. */
export function stlMesh(bytes: Uint8Array): { positions: Float32Array; indices: Uint32Array } | null {
  if (bytes.length >= 84) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const n = dv.getUint32(80, true)
    if (84 + n * 50 === bytes.length && n > 0) {
      const positions = new Float32Array(n * 9)
      for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) positions[t * 9 + k] = dv.getFloat32(84 + t * 50 + 12 + k * 4, true)
      return { positions, indices: Uint32Array.from({ length: n * 3 }, (_, i) => i) }
    }
  }
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 << 20)))
  if (!/^\s*solid/.test(text)) return null
  const nums: number[] = []
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(Number(m[1]), Number(m[2]), Number(m[3]))
  if (nums.length < 9 || nums.some((v) => !Number.isFinite(v))) return null
  const count = Math.floor(nums.length / 9) * 9
  return { positions: Float32Array.from(nums.slice(0, count)), indices: Uint32Array.from({ length: count / 3 }, (_, i) => i) }
}
