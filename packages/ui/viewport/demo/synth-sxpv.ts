// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Demo and benchmark only: builds a realistic SXPV buffer from plate meshes
// with the concept page's toy slicer (contours, walls, rectilinear infill,
// brim, travels), so the viewport can be measured before sx-core emits
// previews. It is not a slicer; its output never reaches a printer.
import { FEATURE, SXPV_FLAG_TRAVELS, SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_TRAVEL_BYTES, SXPV_VERSION } from '@slicerx/contracts'

export interface SynthPart {
  /** Bed coordinates, mm, Z up. */
  positions: Float32Array
  indices: ArrayLike<number>
  tool: number
  object: number
}

export interface SynthOptions {
  layerHeight: number
  lineWidth: number
  walls: number
  infillPct: number
  brimMm: number
}

type Pt = [number, number]
type Loop = { p: Pt[]; closed: boolean; area: number }

function area(p: Pt[]): number {
  let a = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const pj = p[j] as Pt
    const pi = p[i] as Pt
    a += pj[0] * pi[1] - pi[0] * pj[1]
  }
  return a / 2
}

function simplify(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = []
  for (const [x, y] of pts) {
    const last = out[out.length - 1]
    if (last && (x - last[0]) ** 2 + (y - last[1]) ** 2 < 0.0144) continue
    const prev = out[out.length - 2]
    if (last && prev && Math.abs((last[0] - prev[0]) * (y - prev[1]) - (last[1] - prev[1]) * (x - prev[0])) < 0.004) {
      out[out.length - 1] = [x, y]
      continue
    }
    out.push([x, y])
  }
  const first = out[0]
  const last = out[out.length - 1]
  if (closed && out.length >= 2 && first && last && (first[0] - last[0]) ** 2 + (first[1] - last[1]) ** 2 < 0.0144) out.pop()
  return out
}

function offset(pts: Pt[], d: number): Pt[] {
  const n = pts.length
  return pts.map((c, i) => {
    const p = pts[(i - 1 + n) % n] as Pt
    const q = pts[(i + 1) % n] as Pt
    let e1x = c[0] - p[0], e1y = c[1] - p[1], e2x = q[0] - c[0], e2y = q[1] - c[1]
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2
    const n1x = -e1y, n1y = e1x, n2x = -e2y, n2y = e2x
    let mx = n1x + n2x, my = n1y + n2y
    const ml = Math.hypot(mx, my)
    if (ml < 1e-6) { mx = n1x; my = n1y } else { mx /= ml; my /= ml }
    const s = d / Math.max(0.35, mx * n1x + my * n1y)
    return [c[0] + mx * s, c[1] + my * s] as Pt
  })
}

function hull(loops: Pt[][]): Pt[] | null {
  const P = loops.flat().slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (P.length < 3) return null
  const cr = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo: Pt[] = []
  const up: Pt[] = []
  for (const p of P) {
    while (lo.length >= 2 && cr(lo[lo.length - 2] as Pt, lo[lo.length - 1] as Pt, p) <= 0) lo.pop()
    lo.push(p)
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i] as Pt
    while (up.length >= 2 && cr(up[up.length - 2] as Pt, up[up.length - 1] as Pt, p) <= 0) up.pop()
    up.push(p)
  }
  up.pop()
  lo.pop()
  return lo.concat(up)
}

/** Contours of one part at every layer mid plane, joined into loops by shared mesh edges. */
function contours(part: SynthPart, lh: number, N: number): Loop[][] {
  const P = part.positions
  const I = part.indices
  const nv = P.length / 3
  const weld = new Int32Array(nv)
  const map = new Map<string, number>()
  let nw = 0
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round((P[3 * i] ?? 0) * 1000)},${Math.round((P[3 * i + 1] ?? 0) * 1000)},${Math.round((P[3 * i + 2] ?? 0) * 1000)}`
    let id = map.get(k)
    if (id === undefined) {
      id = nw++
      map.set(k, id)
    }
    weld[i] = id
  }
  const segs: number[][] = Array.from({ length: N }, () => [])
  const v = (i: number, c: number): number => P[3 * i + c] ?? 0
  for (let t = 0; t + 2 < I.length; t += 3) {
    const ids = [I[t] ?? 0, I[t + 1] ?? 0, I[t + 2] ?? 0]
    const zs = ids.map((i) => v(i, 2))
    const zmin = Math.min(...zs), zmax = Math.max(...zs)
    const k0 = Math.max(0, Math.ceil(zmin / lh - 0.5))
    const k1 = Math.min(N - 1, Math.floor(zmax / lh - 0.5))
    if (k1 < k0) continue
    const [ia, ib, ic] = ids as [number, number, number]
    const ux = v(ib, 0) - v(ia, 0), uy = v(ib, 1) - v(ia, 1), uz = v(ib, 2) - v(ia, 2)
    const wx = v(ic, 0) - v(ia, 0), wy = v(ic, 1) - v(ia, 1), wz = v(ic, 2) - v(ia, 2)
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz
    for (let k = k0; k <= k1; k++) {
      const z = (k + 0.5) * lh
      const pts: number[] = []
      for (let e = 0; e < 3; e++) {
        const A = ids[e] ?? 0
        const B = ids[(e + 1) % 3] ?? 0
        const az = v(A, 2), bz = v(B, 2)
        if (az >= z !== bz >= z) {
          const s = (z - az) / (bz - az)
          const wa = weld[A] ?? 0, wb = weld[B] ?? 0
          pts.push(v(A, 0) + (v(B, 0) - v(A, 0)) * s, v(A, 1) + (v(B, 1) - v(A, 1)) * s, wa < wb ? wa * nw + wb : wb * nw + wa)
        }
      }
      if (pts.length !== 6) continue
      let [px, py, pk, qx, qy, qk] = pts as [number, number, number, number, number, number]
      if ((qy - py) * nx - (qx - px) * ny < 0) {
        ;[px, qx] = [qx, px]
        ;[py, qy] = [qy, py]
        ;[pk, qk] = [qk, pk]
      }
      segs[k]?.push(px, py, qx, qy, pk, qk)
    }
  }
  let signed = 0
  const out = segs.map((s) => {
    const n = s.length / 6
    const byStart = new Map<number, number>()
    for (let i = 0; i < n; i++) if (!byStart.has(s[6 * i + 4] ?? 0)) byStart.set(s[6 * i + 4] ?? 0, i)
    const used = new Uint8Array(n)
    const loops: Loop[] = []
    for (let i = 0; i < n; i++) {
      if (used[i]) continue
      const pts: Pt[] = []
      let cur = i
      let closed = false
      for (;;) {
        used[cur] = 1
        pts.push([s[6 * cur] ?? 0, s[6 * cur + 1] ?? 0])
        const nx2 = byStart.get(s[6 * cur + 5] ?? 0)
        if (nx2 === undefined || used[nx2]) {
          if (nx2 === i) closed = true
          else pts.push([s[6 * cur + 2] ?? 0, s[6 * cur + 3] ?? 0])
          break
        }
        cur = nx2
      }
      const sp = simplify(pts, closed)
      if (closed && sp.length >= 3) {
        const a = area(sp)
        if (Math.abs(a) > 0.05) {
          loops.push({ p: sp, closed: true, area: a })
          signed += a
        }
      } else if (!closed && sp.length >= 2) loops.push({ p: sp, closed: false, area: 0 })
    }
    return loops
  })
  if (signed < 0) for (const L of out) for (const lp of L) { lp.p.reverse(); lp.area = -lp.area }
  return out
}

export function synthesizePreview(parts: SynthPart[], o: SynthOptions): ArrayBuffer {
  const { layerHeight: lh, lineWidth: lw, walls } = o
  const dens = o.infillPct / 100
  let maxZ = 0
  for (const p of parts) for (let i = 2; i < p.positions.length; i += 3) maxZ = Math.max(maxZ, p.positions[i] ?? 0)
  const N = Math.max(1, Math.ceil(maxZ / lh - 1e-6))
  const loops = parts.map((p) => contours(p, lh, N))

  const seg: number[] = []
  const trav: number[] = []
  const layerStart: number[] = []
  const travelStart: number[] = []
  const layerTime: number[] = []
  const wUm = Math.round(lw * 1000)
  const hUm = Math.round(lh * 1000)
  let last: Pt | null = null
  let t = 0
  const emitPath = (pts: Pt[], closed: boolean, z: number, feature: number, tool: number, speed: number): void => {
    const first = pts[0]
    if (!first || pts.length < 2) return
    if (last) trav.push(last[0], last[1], first[0], first[1])
    t += 0.16
    const n = closed ? pts.length : pts.length - 1
    for (let i = 0; i < n; i++) {
      const a = pts[i] as Pt
      const b = pts[(i + 1) % pts.length] as Pt
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len < 1e-4) continue
      seg.push(a[0], a[1], b[0], b[1], z, wUm | (hUm << 16), feature | (tool << 8) | (Math.round(speed * 10) << 16), lw * lh * speed)
      t += len / speed
    }
    last = closed ? first : (pts[pts.length - 1] ?? first)
  }

  for (let k = 0; k < N; k++) {
    layerStart.push(seg.length / 8)
    travelStart.push(trav.length / 4)
    t = 1.1
    const z = (k + 1) * lh
    const firstLayer = k === 0 ? 0.3 : 1
    if (k === 0 && o.brimMm > 0) {
      const byObj = new Map<number, Pt[][]>()
      parts.forEach((p, i) => {
        for (const lp of loops[i]?.[0] ?? []) if (lp.closed && lp.area > 0) byObj.set(p.object, [...(byObj.get(p.object) ?? []), lp.p])
      })
      for (const [obj, pl] of byObj) {
        const h = hull(pl)
        if (!h) continue
        const tool = parts.find((p) => p.object === obj)?.tool ?? 0
        const nb = Math.round(o.brimMm / lw)
        for (let i = nb; i >= 1; i--) emitPath(offset(h, -i * lw), true, z, FEATURE.brimSkirt, tool, 50)
      }
    }
    const order = parts.map((_, i) => i).filter((i) => (loops[i]?.[k]?.length ?? 0) > 0)
    order.sort((a, b) => ((parts[a]?.tool ?? 0) - (parts[b]?.tool ?? 0)) * (k % 2 ? -1 : 1) || a - b)
    for (const pi of order) {
      const part = parts[pi] as SynthPart
      const bounds: Pt[][] = []
      for (const lp of loops[pi]?.[k] ?? []) {
        if (!lp.closed) {
          emitPath(lp.p, false, z, FEATURE.outerWall, part.tool, 200 * firstLayer)
          continue
        }
        const rings: Pt[][] = [lp.p]
        for (let w = 1; w <= walls; w++) {
          const off = offset(lp.p, w * lw)
          const a = area(off)
          if (Math.sign(a) !== Math.sign(lp.area) || Math.abs(a) >= Math.abs(lp.area) || Math.abs(a) < lw * lw * 2) break
          if (w < walls) rings.push(off)
          else bounds.push(off)
        }
        for (let w = rings.length - 1; w >= 0; w--) emitPath(rings[w] as Pt[], true, z, w === 0 ? FEATURE.outerWall : FEATURE.innerWall, part.tool, (w === 0 ? 200 : 300) * firstLayer)
      }
      const solid = k < 3
      const d = solid ? 1 : dens
      if (d <= 0 || bounds.length === 0) continue
      const ang = ((k % 2 ? 45 : -45) * Math.PI) / 180
      const c = Math.cos(ang), s = Math.sin(ang), sp = lw / d
      const E: number[] = []
      let vmin = Infinity, vmax = -Infinity
      for (const b of bounds) {
        for (let i = 0; i < b.length; i++) {
          const p1 = b[i] as Pt
          const p2 = b[(i + 1) % b.length] as Pt
          const u1 = p1[0] * c + p1[1] * s, v1 = -p1[0] * s + p1[1] * c
          const u2 = p2[0] * c + p2[1] * s, v2 = -p2[0] * s + p2[1] * c
          E.push(u1, v1, u2, v2)
          vmin = Math.min(vmin, v1)
          vmax = Math.max(vmax, v1)
        }
      }
      let flip = false
      for (let vv = Math.ceil(vmin / sp) * sp + 1e-4; vv < vmax; vv += sp) {
        const xs: number[] = []
        for (let e = 0; e < E.length; e += 4) {
          const u1 = E[e] ?? 0, v1 = E[e + 1] ?? 0, u2 = E[e + 2] ?? 0, v2 = E[e + 3] ?? 0
          if (v1 <= vv !== v2 <= vv) xs.push(u1 + ((vv - v1) / (v2 - v1)) * (u2 - u1))
        }
        xs.sort((a, b) => a - b)
        const runs: [number, number][] = []
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const ua = xs[i] ?? 0, ub = xs[i + 1] ?? 0
          if (ub - ua >= lw) runs.push([ua, ub])
        }
        if (flip) runs.reverse()
        for (const [ua, ub] of runs) {
          const [a0, a1] = flip ? [ub, ua] : [ua, ub]
          emitPath([[a0 * c - vv * s, a0 * s + vv * c], [a1 * c - vv * s, a1 * s + vv * c]], false, z, solid ? FEATURE.bottomSurface : FEATURE.sparseInfill, part.tool, (solid ? 250 : 270) * firstLayer)
        }
        flip = !flip
      }
    }
    layerTime.push(t)
  }
  layerStart.push(seg.length / 8)
  travelStart.push(trav.length / 4)

  const S = seg.length / 8
  const T = trav.length / 4
  const bytes = SXPV_HEADER_BYTES + (N + 1) * 4 + N * 8 + (N + 1) * 4 + S * SXPV_SEGMENT_BYTES + T * SXPV_TRAVEL_BYTES
  const raw = new ArrayBuffer(bytes)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint16(6, SXPV_FLAG_TRAVELS, true)
  dv.setUint32(8, S, true)
  dv.setUint32(12, N, true)
  dv.setUint32(16, T, true)
  dv.setUint32(20, 1 + Math.max(0, ...parts.map((p) => p.tool)), true)
  dv.setFloat32(24, lh, true)
  let off = SXPV_HEADER_BYTES
  new Uint32Array(raw, off, N + 1).set(layerStart); off += (N + 1) * 4
  new Float32Array(raw, off, N).set(Array.from({ length: N }, (_, k) => (k + 1) * lh)); off += N * 4
  new Float32Array(raw, off, N).set(layerTime); off += N * 4
  new Uint32Array(raw, off, N + 1).set(travelStart); off += (N + 1) * 4
  const f32 = new Float32Array(raw, off, S * 8)
  const u32 = new Uint32Array(raw, off, S * 8)
  for (let i = 0; i < S; i++) {
    const b = i * 8
    f32[b] = seg[b] ?? 0
    f32[b + 1] = seg[b + 1] ?? 0
    f32[b + 2] = seg[b + 2] ?? 0
    f32[b + 3] = seg[b + 3] ?? 0
    f32[b + 4] = seg[b + 4] ?? 0
    u32[b + 5] = seg[b + 5] ?? 0
    u32[b + 6] = seg[b + 6] ?? 0
    f32[b + 7] = seg[b + 7] ?? 0
  }
  off += S * SXPV_SEGMENT_BYTES
  new Float32Array(raw, off, T * 4).set(trav)
  return raw
}
