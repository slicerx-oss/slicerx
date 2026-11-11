// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.look: a picture of a design for the model to look at, once, when a follow-up is vague ("add bevels", "make it
// nicer", a part word that names nothing in the plan). It draws the design at 512 px with its crease and open edges as
// dark lines, from above at an angle and, when asked, from the side along its long side, in the project's filament
// colors and its paint. The picture goes back to the model of the turn only; the tab shows the call as one plain line.
import { bakeMesh, type DesignHost } from '@slicerx/cad-history'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { designArg } from './design-tools'
import type { FilamentList } from './tab-filaments'

/** The picture's long side, px. */
export const LOOK_PX = 512
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
  return defineTool({
    name: 'design.look',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    title: 'Look at the model',
    description:
      'Look at a design as the person sees it: a 512 px picture with its edges drawn, from above at an angle, and with side also from its long side. Call it once on a vague follow-up (add bevels, more detail, make it nicer, smooth it, or a part word that names nothing in the plan), to see which parts are plain blocks and which part the person means, before changing anything. Nothing is changed.',
    input: z.object({
      design: designArg,
      side: z.boolean().default(false).describe('Also a picture from the long side, when the first does not tell a plain block from a shaped one'),
    }),
    async run(i) {
      const d = host.get(i.design)
      if (!d.parts.length) return { ok: false, summary: `${d.name} has no parts to look at yet` }
      const colors = (filaments?.list() ?? []).map((f) => f.color).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
      const meshes = d.parts.map((p) => bakeMesh(p, d.transform))
      let lo = [Infinity, Infinity, Infinity]
      let hi = [-Infinity, -Infinity, -Infinity]
      for (const m of meshes)
        for (let n = 0; n + 2 < m.positions.length; n += 3) {
          lo = lo.map((v, a) => Math.min(v, m.positions[n + a]!))
          hi = hi.map((v, a) => Math.max(v, m.positions[n + a]!))
        }
      const width = Math.max(0.08, Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) * 0.0025)
      // the side picture looks along y; a design longer in y is turned a quarter first
      const turn = hi[1]! - lo[1]! > hi[0]! - lo[0]!
      const draw = async (view: 'iso' | 'front', turned: boolean) => {
        const T = turned ? [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        const objects: Record<string, unknown>[] = d.parts.map((p, k) => {
          const paint = p.paint?.['color']
          return { mesh: { positions: Array.from(meshes[k]!.positions), indices: Array.from(meshes[k]!.indices) }, transform: T, slot: p.slot, ...(paint && Object.keys(paint).length ? { paint } : {}) }
        })
        for (const m of meshes) {
          const e = edgeLines(m.positions, m.indices, width)
          if (e) objects.push({ mesh: e, transform: T, slot: 1, color: '#1a1a1a' })
        }
        const r = (await host.call('render', { objects, view, size: LOOK_PX, image: true, ...(colors.length ? { colors: colors.slice(0, 32) } : {}) })) as { pngBase64?: string }
        return r.pngBase64
      }
      const shots = [await draw('iso', false), ...(i.side ? [await draw('front', turn)] : [])].filter((x): x is string => typeof x === 'string')
      if (!shots.length) return { ok: false, summary: 'The picture could not be drawn' }
      return { summary: 'Looked at the model', output: { design: d.id, views: i.side ? ['iso', 'side'] : ['iso'], px: LOOK_PX }, images: shots.map((data) => ({ mime: 'image/png' as const, data })) }
    },
  }) as PilotTool<never>
}
