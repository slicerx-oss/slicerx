// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate's picture for the plate grid: its objects drawn shaded from the front and above, in their filament colors,
// with a dark edge where one surface steps away from another, so small parts (buttons, connectors) read at a glance.
// Drawn on the processor with a depth buffer into a small image, once per plate and size, and kept: never per frame,
// and never a second graphics context next to the 3D view's. Plates wait in a queue and draw one at a time when the
// page is idle, so opening the grid of a big project does not stall it.
import type { PlateEntry } from '../../state/store'
import { brandAccent } from '../../edition'

/** The view: turned 30 degrees around the bed's up axis, looking down 35 degrees, as a slicer's plate picture does. */
const TURN = (-30 * Math.PI) / 180
const TILT = (35 * Math.PI) / 180
/** Light in view space (right, up, toward the viewer), from the upper left front. */
const LIGHT = norm([-0.45, 0.55, 0.7])
const AMBIENT = 0.38
/** How far a neighbor's depth may differ, as a share of the plate's depth range, before the edge is drawn. */
const EDGE_STEP = 0.02
const EDGE_SHADE = 0.55

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function rgbOf(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(color.trim())
  if (!m) return [180, 180, 190]
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** One part ready to draw: its vertices in view space (x right, y up, z toward the viewer) and its color. */
interface ViewPart {
  v: Float64Array
  indices: ArrayLike<number>
  rgb: [number, number, number]
}

function toView(objects: readonly PlateEntry[]): ViewPart[] {
  const c = Math.cos(TURN)
  const s = Math.sin(TURN)
  const ct = Math.cos(TILT)
  const st = Math.sin(TILT)
  const out: ViewPart[] = []
  for (const e of objects) {
    const m = e.transform
    const dim = e.printable === false
    e.parts.forEach((part, i) => {
      const p = part.positions
      const n = Math.floor(p.length / 3)
      const v = new Float64Array(n * 3)
      for (let k = 0; k < n; k++) {
        const x0 = p[3 * k] ?? 0
        const y0 = p[3 * k + 1] ?? 0
        const z0 = p[3 * k + 2] ?? 0
        const x = (m[0] ?? 1) * x0 + (m[4] ?? 0) * y0 + (m[8] ?? 0) * z0 + (m[12] ?? 0)
        const y = (m[1] ?? 0) * x0 + (m[5] ?? 1) * y0 + (m[9] ?? 0) * z0 + (m[13] ?? 0)
        const z = (m[2] ?? 0) * x0 + (m[6] ?? 0) * y0 + (m[10] ?? 1) * z0 + (m[14] ?? 0)
        const xr = x * c - y * s
        const yr = x * s + y * c
        v[3 * k] = xr
        v[3 * k + 1] = yr * st + z * ct
        v[3 * k + 2] = -yr * ct + z * st
      }
      const rgb = dim ? ([128, 128, 140] as [number, number, number]) : rgbOf(e.colors[i] ?? e.colors[0] ?? brandAccent())
      out.push({ v, indices: part.indices, rgb })
    })
  }
  return out
}

/**
 * The plate's objects drawn into a `width` by `height` RGBA picture, fitted with a little room around them, the rest
 * left clear. Null with nothing on the plate.
 */
export function rasterPlate(objects: readonly PlateEntry[], width: number, height: number): Uint8ClampedArray | null {
  const parts = toView(objects)
  let x0 = Infinity
  let y0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let z1 = -Infinity
  for (const { v } of parts) {
    for (let k = 0; k < v.length; k += 3) {
      const x = v[k]!
      const y = v[k + 1]!
      const z = v[k + 2]!
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (z < z0) z0 = z
      if (z > z1) z1 = z
    }
  }
  if (!Number.isFinite(x0)) return null
  const pad = 0.08
  const scale = Math.min((width * (1 - 2 * pad)) / Math.max(1e-6, x1 - x0), (height * (1 - 2 * pad)) / Math.max(1e-6, y1 - y0))
  const ox = width / 2 - ((x0 + x1) / 2) * scale
  const oy = height / 2 + ((y0 + y1) / 2) * scale
  const depth = new Float32Array(width * height).fill(-Infinity)
  const px = new Uint8ClampedArray(width * height * 4)
  for (const { v, indices, rgb } of parts) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = 3 * (indices[t] ?? 0)
      const b = 3 * (indices[t + 1] ?? 0)
      const c = 3 * (indices[t + 2] ?? 0)
      const ax = v[a]!, ay = v[a + 1]!, az = v[a + 2]!
      const bx = v[b]!, by = v[b + 1]!, bz = v[b + 2]!
      const cx = v[c]!, cy = v[c + 1]!, cz = v[c + 2]!
      // Face normal in view space; both sides are lit, the depth test keeps the near one.
      const ux = bx - ax, uy = by - ay, uz = bz - az
      const wx = cx - ax, wy = cy - ay, wz = cz - az
      let nx = uy * wz - uz * wy
      let ny = uz * wx - ux * wz
      let nz = ux * wy - uy * wx
      const nl = Math.hypot(nx, ny, nz)
      if (nl === 0) continue
      nx /= nl
      ny /= nl
      nz /= nl
      if (nz < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      const lit = Math.min(1, AMBIENT + (1 - AMBIENT) * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) + 0.12 * nz)
      const r = rgb[0] * lit
      const g = rgb[1] * lit
      const bl = rgb[2] * lit
      // Screen space, y down.
      const sx0 = ox + ax * scale, sy0 = oy - ay * scale
      const sx1 = ox + bx * scale, sy1 = oy - by * scale
      const sx2 = ox + cx * scale, sy2 = oy - cy * scale
      const area = (sx1 - sx0) * (sy2 - sy0) - (sy1 - sy0) * (sx2 - sx0)
      if (Math.abs(area) < 1e-9) continue
      const minX = Math.max(0, Math.floor(Math.min(sx0, sx1, sx2)))
      const maxX = Math.min(width - 1, Math.ceil(Math.max(sx0, sx1, sx2)))
      const minY = Math.max(0, Math.floor(Math.min(sy0, sy1, sy2)))
      const maxY = Math.min(height - 1, Math.ceil(Math.max(sy0, sy1, sy2)))
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5
        for (let x = minX; x <= maxX; x++) {
          const pxx = x + 0.5
          const w0 = ((sx1 - pxx) * (sy2 - py) - (sy1 - py) * (sx2 - pxx)) / area
          const w1 = ((sx2 - pxx) * (sy0 - py) - (sy2 - py) * (sx0 - pxx)) / area
          const w2 = 1 - w0 - w1
          if (w0 < 0 || w1 < 0 || w2 < 0) continue
          const z = w0 * az + w1 * bz + w2 * cz
          const i = y * width + x
          if (z <= depth[i]!) continue
          depth[i] = z
          px[4 * i] = r
          px[4 * i + 1] = g
          px[4 * i + 2] = bl
          px[4 * i + 3] = 255
        }
      }
    }
  }
  // A dark edge where a surface steps away from the one beside it, or meets the clear background.
  const step = Math.max(1e-6, (z1 - z0) * scale) * EDGE_STEP
  const edge = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const d = depth[i]!
      if (d === -Infinity) continue
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
        if (j < 0) continue
        const e = depth[j]!
        if (e === -Infinity || (e - d) * scale > step) {
          edge[i] = 1
          break
        }
      }
    }
  }
  for (let i = 0; i < edge.length; i++) {
    if (!edge[i]) continue
    px[4 * i] = px[4 * i]! * EDGE_SHADE
    px[4 * i + 1] = px[4 * i + 1]! * EDGE_SHADE
    px[4 * i + 2] = px[4 * i + 2]! * EDGE_SHADE
  }
  return px
}

/** What makes two plates the same picture: each object, its placement, colors and meshes. */
const meshIds = new WeakMap<object, number>()
let nextMesh = 1
function meshId(o: object): number {
  let id = meshIds.get(o)
  if (!id) meshIds.set(o, (id = nextMesh++))
  return id
}
export function plateKey(objects: readonly PlateEntry[], width: number, height: number): string {
  return `${width}x${height}|${objects.map((e) => `${e.id}:${e.parts.map((p) => meshId(p.positions)).join('.')}:${e.transform.map((n) => n.toFixed(3)).join(',')}:${e.colors.join(',')}:${e.printable === false ? 0 : 1}`).join('|')}`
}

/**
 * The pictures kept, as PNG blobs behind object URLs, least recently used first. It holds at most `cap` pictures and
 * `budget` bytes of PNG, whichever comes first; a picture that goes has its URL revoked. A picture in use is read on
 * every draw of its tile, which keeps it at the recent end.
 */
export class PictureCache {
  private entries = new Map<string, { url: string | null; bytes: number }>()
  private total = 0
  constructor(
    readonly cap: number,
    readonly budget: number,
    private readonly revoke: (url: string) => void = (u) => URL.revokeObjectURL(u),
  ) {}

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.total
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** The picture's URL (null: nothing to draw), marked as just used; undefined when it is not kept. */
  get(key: string): string | null | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    this.entries.delete(key)
    this.entries.set(key, e)
    return e.url
  }

  set(key: string, url: string | null, bytes: number): void {
    const old = this.entries.get(key)
    if (old) this.drop(key, old)
    this.entries.set(key, { url, bytes })
    this.total += bytes
    while (this.entries.size > this.cap || (this.total > this.budget && this.entries.size > 1)) {
      const [k, e] = this.entries.entries().next().value as [string, { url: string | null; bytes: number }]
      this.drop(k, e)
    }
  }

  private drop(key: string, e: { url: string | null; bytes: number }): void {
    this.entries.delete(key)
    this.total -= e.bytes
    if (e.url) this.revoke(e.url)
  }
}

/** 48 pictures or 4 MB of PNG: about three times a big project's grid. */
export const PICTURE_CAP = 48
export const PICTURE_BUDGET = 4 * 1024 * 1024
const pictures = new PictureCache(PICTURE_CAP, PICTURE_BUDGET)
type Job = { objects: readonly PlateEntry[]; width: number; height: number; done: Set<() => void> }
const waiting = new Map<string, Job>()
let running = false

/** How much the kept pictures hold, for a check from the console or a test. */
export function pictureCacheStats(): { pictures: number; bytes: number; cap: number; budget: number } {
  return { pictures: pictures.size, bytes: pictures.bytes, cap: PICTURE_CAP, budget: PICTURE_BUDGET }
}

/**
 * The plate's picture URL when it is drawn, null when there is nothing to draw, else undefined. With `queue`, a
 * picture not drawn yet joins the queue and `ready` runs once it is; without, nothing is queued (a tile out of view).
 * Returns a function that stops waiting, for a tile that leaves the view: a queued picture nobody waits for is skipped.
 */
export function platePicture(objects: readonly PlateEntry[], width: number, height: number, ready: () => void, queue = true): { url: string | null | undefined; cancel: () => void } {
  const key = plateKey(objects, width, height)
  const url = pictures.get(key)
  if (url !== undefined || !queue) return { url, cancel: () => undefined }
  const w = waiting.get(key)
  if (w) w.done.add(ready)
  else waiting.set(key, { objects, width, height, done: new Set([ready]) })
  pump()
  return { url: undefined, cancel: () => void waiting.get(key)?.done.delete(ready) }
}

const idle = (fn: () => void): void => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  if (ric) ric(fn, { timeout: 200 })
  else setTimeout(fn, 16)
}

function pngOf(data: Uint8ClampedArray, width: number, height: number): Promise<Blob | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

function pump(): void {
  if (running) return
  // Pictures whose tiles all left the view are not drawn.
  for (const [k, j] of waiting) if (j.done.size === 0) waiting.delete(k)
  if (waiting.size === 0) return
  running = true
  idle(() => {
    const [key, job] = waiting.entries().next().value as [string, Job]
    waiting.delete(key)
    const finish = (url: string | null, bytes: number) => {
      pictures.set(key, url, bytes)
      for (const f of job.done) f()
      running = false
      pump()
    }
    let data: Uint8ClampedArray | null = null
    try {
      data = rasterPlate(job.objects, job.width, job.height)
    } catch {
      data = null
    }
    if (!data) return finish(null, 0)
    pngOf(data, job.width, job.height).then(
      (blob) => (blob ? finish(URL.createObjectURL(blob), blob.size) : finish(null, 0)),
      () => finish(null, 0),
    )
  })
}
