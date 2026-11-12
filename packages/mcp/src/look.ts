// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.look: a picture of a design for the model to look at, once, when a follow-up is vague ("add bevels", "make it
// nicer", a part word that names nothing in the plan). It draws the design at 512 px with its crease and open edges as
// dark lines, from above at an angle and, when asked, from the side along its long side, in the project's filament
// colors and its paint. The picture goes back to the model of the turn only; the tab shows the call as one plain line.
import { bakeMesh, type DesignHost, type HistoryMesh } from '@slicerx/cad-history'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { designArg } from './design-tools'
import type { FilamentList } from './tab-filaments'

/** The picture's long side, px. */
export const LOOK_PX = 512
/**
 * The least share of the whole-model view, in percent of the pixels the model covers before or after, that a follow-up
 * change has to move for a person to see it at that view. Below it, the change is strengthened once before the reply.
 */
export const VISIBLE_FLOOR_PCT = 2
/** How far two pixels' colors may differ (summed over red, green and blue) and still read as the same. */
const SAME_COLOR = 60

/** A base64 string's bytes, with no node builtin: the page has no Buffer. */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Every byte a stream gives, joined. Read with a reader: node's Response.arrayBuffer needs Buffer. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return joinBytes(parts)
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A zlib stream inflated with the platform's DecompressionStream, which both the page and node have. */
function inflate(data: Uint8Array): Promise<Uint8Array> {
  return readAll(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')))
}

const u32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0

/**
 * An RGB(A) 8-bit PNG decoded to its pixels, as the engine's render writes it; null for any other kind. It uses no node
 * builtin, so it runs in the app's page as it does in node.
 */
export async function decodePng(b64: string): Promise<{ w: number; h: number; px: Uint8Array; ch: number } | null> {
  const buf = fromBase64(b64)
  if (buf.length < 8 || u32(buf, 0) !== 0x89504e47) return null
  let at = 8
  let w = 0
  let h = 0
  let ch = 0
  const idat: Uint8Array[] = []
  while (at + 8 <= buf.length) {
    const len = u32(buf, at)
    const type = String.fromCharCode(buf[at + 4]!, buf[at + 5]!, buf[at + 6]!, buf[at + 7]!)
    const data = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      w = u32(data, 0)
      h = u32(data, 4)
      if (data[8] !== 8 || data[12] !== 0) return null
      ch = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0
      if (!ch) return null
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    at += 12 + len
  }
  if (!w || !h || !idat.length) return null
  const raw = await inflate(joinBytes(idat)).catch(() => null)
  const stride = w * ch
  if (!raw || raw.length < h * (stride + 1)) return null
  const px = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch]! : 0
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch]! : 0
      const r = row[x]!
      let v: number
      if (f === 0) v = r
      else if (f === 1) v = r + a
      else if (f === 2) v = r + b
      else if (f === 3) v = r + ((a + b) >> 1)
      else {
        const p0 = a + b - c
        const pa = Math.abs(p0 - a)
        const pb = Math.abs(p0 - b)
        const pc = Math.abs(p0 - c)
        v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      px[y * stride + x] = v & 255
    }
  }
  return { w, h, px, ch }
}

/**
 * The share of the model's pixels (covered before or after, in percent) whose color changed between two pictures of
 * one framing; the background is the top left pixel's color.
 */
export async function changedShare(before: string, after: string): Promise<number | null> {
  const [a, b] = await Promise.all([decodePng(before), decodePng(after)])
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null
  const bg = (img: typeof a, i: number) => Math.abs(img.px[i]! - img.px[0]!) + Math.abs(img.px[i + 1]! - img.px[1]!) + Math.abs(img.px[i + 2]! - img.px[2]!) > SAME_COLOR
  let covered = 0
  let changed = 0
  for (let p = 0; p < a.w * a.h; p++) {
    const i = p * a.ch
    const j = p * b.ch
    if (!bg(a, i) && !bg(b, j)) continue
    covered++
    if (Math.abs(a.px[i]! - b.px[j]!) + Math.abs(a.px[i + 1]! - b.px[j + 1]!) + Math.abs(a.px[i + 2]! - b.px[j + 2]!) > SAME_COLOR) changed++
  }
  return covered ? (changed / covered) * 100 : 0
}

/** A design's parts as drawn: baked meshes with their slots and paint. */
interface Drawn {
  meshes: HistoryMesh[]
  slots: number[]
  paints: (Record<string, unknown> | undefined)[]
}
const EDGE_DEG = 35

/**
 * Crease and open edges of a mesh (faces meeting at more than EDGE_DEG, or a side with one face) as thin dark prisms,
 * so the engine's render draws them as lines with depth like any part.
 */
export function edgeLines(positions: ArrayLike<number>, indices: ArrayLike<number>, width: number): { positions: number[]; indices: number[] } | undefined {
  const key = (i: number) => `${Math.round(positions[i * 3]! * 1e4)},${Math.round(positions[i * 3 + 1]! * 1e4)},${Math.round(positions[i * 3 + 2]! * 1e4)}`
  const ids = new Map<string, number>()
  const pts: number[][] = []
  const weld = (i: number) => {
    const k = key(i)
    let id = ids.get(k)
    if (id === undefined) {
      id = pts.length
      ids.set(k, id)
      pts.push([positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!])
    }
    return id
  }
  const sides = new Map<string, { a: number; b: number; n: number[][] }>()
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const v = [weld(indices[t]!), weld(indices[t + 1]!), weld(indices[t + 2]!)]
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue
    const [p, q, r] = v.map((i) => pts[i]!) as [number[], number[], number[]]
    const e1 = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!]
    const e2 = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!]
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const l = Math.hypot(n[0]!, n[1]!, n[2]!)
    if (l < 1e-12) continue
    const nn = n.map((x) => x / l)
    for (let k = 0; k < 3; k++) {
      const a = v[k]!
      const b = v[(k + 1) % 3]!
      const s = a < b ? `${a}_${b}` : `${b}_${a}`
      const e = sides.get(s) ?? { a: Math.min(a, b), b: Math.max(a, b), n: [] }
      e.n.push(nn)
      sides.set(s, e)
    }
  }
  const cos = Math.cos((EDGE_DEG * Math.PI) / 180)
  const out: number[] = []
  const tri: number[] = []
  const h = width / 2
  for (const e of sides.values()) {
    const sharp = e.n.length !== 2 || e.n[0]![0]! * e.n[1]![0]! + e.n[0]![1]! * e.n[1]![1]! + e.n[0]![2]! * e.n[1]![2]! < cos
    if (!sharp) continue
    const A = pts[e.a]!
    const B = pts[e.b]!
    const d = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!]
    const dl = Math.hypot(d[0]!, d[1]!, d[2]!)
    if (dl < 1e-9) continue
    const dn = d.map((x) => x / dl)
    const ref = Math.abs(dn[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    let u = [dn[1]! * ref[2]! - dn[2]! * ref[1]!, dn[2]! * ref[0]! - dn[0]! * ref[2]!, dn[0]! * ref[1]! - dn[1]! * ref[0]!]
    const ul = Math.hypot(u[0]!, u[1]!, u[2]!)
    u = u.map((x) => (x / ul) * h)
    const w = [dn[1]! * u[2]! - dn[2]! * u[1]!, dn[2]! * u[0]! - dn[0]! * u[2]!, dn[0]! * u[1]! - dn[1]! * u[0]!]
    const base = out.length / 3
    // the prism runs a half width past each end, so lines meet at corners
    for (const P of [A.map((x, i) => x - dn[i]! * h), B.map((x, i) => x + dn[i]! * h)])
      for (const [su, sw] of [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ] as const)
        out.push(P[0]! + su * u[0]! + sw * w[0]!, P[1]! + su * u[1]! + sw * w[1]!, P[2]! + su * u[2]! + sw * w[2]!)
    for (let k = 0; k < 4; k++) {
      const a0 = base + k
      const a1 = base + ((k + 1) % 4)
      tri.push(a0, a1, a1 + 4, a0, a1 + 4, a0 + 4)
    }
    tri.push(base, base + 2, base + 1, base, base + 3, base + 2, base + 4, base + 5, base + 6, base + 4, base + 6, base + 7)
    if (tri.length > 1_500_000) break
  }
  return tri.length ? { positions: out, indices: tri } : undefined
}

/** The tab's design.look, over its designs and, where the host has them, the project's filament colors. */
export function lookTool(host: DesignHost, filaments?: FilamentList): PilotTool<never> {
  // the last look at each design, by conversation: what compare measures a change against
  const looked = new Map<string, Drawn>()
  return defineTool({
    name: 'design.look',
    version: '1.1.1',
    source: 'command',
    permission: 'read',
    title: 'Look at the model',
    description:
      'Look at a design as the person sees it: a 512 px picture with its edges drawn, from above at an angle, and with side also from its long side. Call it once on a vague follow-up (add bevels, more detail, make it nicer, smooth it, or a part word that names nothing in the plan), to see which parts are plain blocks and which part the person means, before changing anything. Nothing is changed.',
    input: z.object({
      design: designArg,
      side: z.boolean().default(false).describe('Also a picture from the long side, when the first does not tell a plain block from a shaped one'),
      compare: z.boolean().optional().describe('After a change: how much of the whole-model view changed since the last look, measured, with the picture as it is now'),
    }),
    async run(i, ctx) {
      const d = host.get(i.design)
      if (!d.parts.length) return { ok: false, summary: `${d.name} has no parts to look at yet` }
      const colors = (filaments?.list() ?? []).map((f) => f.color).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
      const now: Drawn = { meshes: d.parts.map((p) => bakeMesh(p, d.transform)), slots: d.parts.map((p) => p.slot), paints: d.parts.map((p) => p.paint?.['color'] as Record<string, unknown> | undefined) }
      const key = `${ctx?.sessionId ?? ''}\u0000${d.id}`
      const bounds = (all: Drawn[]) => {
        let lo = [Infinity, Infinity, Infinity]
        let hi = [-Infinity, -Infinity, -Infinity]
        for (const g of all)
          for (const m of g.meshes)
            for (let n = 0; n + 2 < m.positions.length; n += 3) {
              lo = lo.map((v, a) => Math.min(v, m.positions[n + a]!))
              hi = hi.map((v, a) => Math.max(v, m.positions[n + a]!))
            }
        return { lo, hi }
      }
      const draw = async (g: Drawn, view: 'iso' | 'front', turned: boolean, frame?: { lo: number[]; hi: number[] }) => {
        const { lo, hi } = frame ?? bounds([g])
        const width = Math.max(0.08, Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) * 0.0025)
        const T = turned ? [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        const objects: Record<string, unknown>[] = g.meshes.map((m, k) => {
          const paint = g.paints[k]
          return { mesh: { positions: Array.from(m.positions), indices: Array.from(m.indices) }, transform: T, slot: g.slots[k], ...(paint && Object.keys(paint).length ? { paint } : {}) }
        })
        for (const m of g.meshes) {
          const e = edgeLines(m.positions, m.indices, width)
          if (e) objects.push({ mesh: e, transform: T, slot: 1, color: '#1a1a1a' })
        }
        // a shared frame: a speck at each of the eight corners of both designs' box, padded past the edge lines, so the
        // picture's size and framing come from the frame alone and before and after are drawn alike, pixel for pixel. With a
        // speck at only two corners, raised letters made taller drew 512 x 328 before and 512 x 329 after, which could
        // not be compared.
        if (frame) {
          const pad = width * 4
          for (let k = 0; k < 8; k++) {
            const c = [k & 1 ? hi[0]! + pad : lo[0]! - pad, k & 2 ? hi[1]! + pad : lo[1]! - pad, k & 4 ? hi[2]! + pad : lo[2]! - pad]
            objects.push({ mesh: { positions: [c[0]!, c[1]!, c[2]!, c[0]! + 0.01, c[1]!, c[2]!, c[0]!, c[1]! + 0.01, c[2]!], indices: [0, 1, 2] }, transform: T, slot: 1 })
          }
        }
        const r = (await host.call('render', { objects, view, size: LOOK_PX, image: true, ...(colors.length ? { colors: colors.slice(0, 32) } : {}) })) as { pngBase64?: string }
        return r.pngBase64
      }
      if (i.compare) {
        const was = looked.get(key)
        if (!was) return { ok: false, summary: `No earlier look at ${d.name} in this conversation to compare with; look at it first, before the change` }
        const frame = bounds([was, now])
        const [a, b] = [await draw(was, 'iso', false, frame), await draw(now, 'iso', false, frame)]
        const share = a && b ? await changedShare(a, b) : null
        if (share === null || !b) return { ok: false, summary: 'The change could not be measured' }
        const pct = Math.round(share * 10) / 10
        const below = share < VISIBLE_FLOOR_PCT
        return {
          summary: `Looked at the model again: ${pct}% of the whole-model view changed since the look before the change${below ? `, under the ${VISIBLE_FLOOR_PCT}% a person sees at that view` : ''}`,
          output: { design: d.id, visiblePct: pct, floorPct: VISIBLE_FLOOR_PCT, belowFloor: below, px: LOOK_PX },
          images: [{ mime: 'image/png' as const, data: b }],
        }
      }
      // the side picture looks along y; a design longer in y is turned a quarter first
      const { lo, hi } = bounds([now])
      const turn = hi[1]! - lo[1]! > hi[0]! - lo[0]!
      const shots = [await draw(now, 'iso', false), ...(i.side ? [await draw(now, 'front', turn)] : [])].filter((x): x is string => typeof x === 'string')
      if (!shots.length) return { ok: false, summary: 'The picture could not be drawn' }
      // this look is what a later compare measures a change against
      looked.set(key, now)
      if (looked.size > 50) looked.delete(looked.keys().next().value!)
      return { summary: 'Looked at the model', output: { design: d.id, views: i.side ? ['iso', 'side'] : ['iso'], px: LOOK_PX }, images: shots.map((data) => ({ mime: 'image/png' as const, data })) }
    },
  }) as PilotTool<never>
}
