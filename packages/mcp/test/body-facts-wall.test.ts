// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The thinnest wall design.check reads skips what booleans leave where faces meet: a facet folded under its neighbor,
// a needle with no reliable normal and a speck far smaller than a nozzle. A live Pi 5 case read 0.001 mm and a headphone
// stand 0 mm from such facets, so both failed "minimum wall" though their walls were 1.1 mm and more, and mimir could
// not call either finished. A planter with 3 mm walls read 0.025 mm the same way, from a needle at a drain hole rim,
// and a swept spout with a 1.6 mm wall read 0.067 mm from the rays beside its slanted tip, which leave along the bore.
// It also skips a flat patch narrower than 0.01 mm across: a toy rocket's nose cone joined flush onto its body, both
// on one 25 mm circle with 256 and 160 sides, left strips under the cone microns wide that read a 0.004 mm wall.
// And a far face that does not face back against the start: a twisted vase's 2 mm wall read 0.89 mm at its open rim,
// from the top face to the facets leaning in just under it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { minWall as creativeWall } from '../evals/creative/mesh-checks'
import { minWall } from '../src/body-facts'

type V = [number, number, number]
const mesh = (tris: V[][]) => ({ positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) })

// the far side: a large facet 3 mm under the rest, facing down, so its ray goes up
const FAR: V[] = [[-25, -28.33, -3], [5, 61.67, -3], [35, -28.33, -3]]

describe('the thinnest wall', () => {
  it('a facet folded 0.01 mm under the facet it shares an edge with reads the wall, not the fold', () => {
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    const fold: V[] = [[10, 0, 0], [0, 0, 0], [5, 5, -0.01]]
    const r = minWall([mesh([top, fold, FAR])])
    expect(r.mm).toBeGreaterThan(2.9)
  })

  it('a speck 0.001 mm across, 0.0005 mm over the far side, reads nothing', () => {
    const speck: V[] = [[20, -10, -2.9995], [20.001, -10, -2.9995], [20, -10.001, -2.9995]].reverse() as V[]
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    const r = minWall([mesh([top, speck, FAR])])
    expect(r.mm).toBeGreaterThan(2.9)
  })

  it('a real 1 mm wall still reads 1 mm', () => {
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    const under: V[] = [[-25, -28.33, -1], [5, 61.67, -1], [35, -28.33, -1]]
    expect(minWall([mesh([top, under])]).mm).toBeCloseTo(1, 3)
  })

  it('a needle facet standing on edge is skipped, so its ray along the surface reads no wall of 0.05 mm', () => {
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    // doubled area 0.01 against a longest edge squared of 100: its normal points sideways, at a facet 0.05 mm off
    const needle: V[] = [[0, 0, 0], [10, 0, 0], [5, 0, 0.001]]
    const beside: V[] = [[-5, 0.05, -1], [5, 0.05, 1], [15, 0.05, -1]]
    expect(minWall([mesh([top, needle, beside, FAR])]).mm).toBeCloseTo(3, 3)
  })

  it('a needle lying in the floor at a drain hole rim reads the 3 mm floor, not the hole wall its ray grazes', () => {
    // from a planter built as a 120 mm cylinder, a 114 mm cut down to a 3 mm floor and five 6 mm drain holes: at the
    // rim of the hole around (30, 0), the subtract left a needle facet in the bottom face, 0.016 mm long, and the hole's
    // wall facet beside it leans 0.004 mm over its 3 mm height. The needle's ray goes up along that wall and met it
    // 0.025 mm up, so design.check failed "minimum wall" at 0.03 mm on a part whose walls are 3 mm.
    const needle: V[] = [[32.91094207763672, 0.7071242928504944, 0], [32.910587310791016, 0.7081326842308044, 0], [32.90554428100586, 0.7225484251976013, 0]]
    const holeWall: V[] = [[32.70290756225586, 1.3016512393951416, 3], [32.910587310791016, 0.7081326842308044, 0], [32.91094207763672, 0.7071242928504944, 0]]
    // a plain facet of the bottom beside the needle, facing down, and the floor's top face 3 mm over it, facing up
    const bottom: V[] = [[31, -2, 0], [29, -0.5, 0], [32, -0.5, 0]]
    const floorTop: V[] = [[20, -10, 3], [45, -10, 3], [32, 20, 3]]
    expect(minWall([mesh([needle, holeWall, bottom, floorTop])]).mm).toBeCloseTo(3, 3)
  })

  it('a closed plate 20 x 20 x 0.4 mm still reads its 0.4 mm wall, too thin for twice a 0.4 mm nozzle', () => {
    const r = minWall([box(20, 20, 0.4)])
    expect(r.mm).toBeCloseTo(0.4, 3)
    expect(r.mm!).toBeLessThan(0.8)
  })

  it('a closed strip 2 mm wide and 0.4 mm thick still reads 0.4 mm', () => {
    expect(minWall([box(20, 2, 0.4)]).mm).toBeCloseTo(0.4, 3)
  })

  it('a closed strip 2 mm wide and 0.3 mm thick still reads 0.3 mm', () => {
    expect(minWall([box(20, 2, 0.3)]).mm).toBeCloseTo(0.3, 3)
  })

  it('a toy rocket whose cone was joined flush onto its body reads its 5 mm fins, not the seam ledge under the cone', () => {
    // the body as the engine stored it: a 160-sided body and a 256-sided cone base on one 25 mm circle at z = 100. Where
    // the cone runs outside the body, the join leaves strips facing down under it, up to 0.0048 mm wide and 0.32 mm2 in
    // all; their rays meet the cone's slope 0.004 mm up. The thinnest wall after them is the fins.
    const rocket = JSON.parse(gunzipSync(readFileSync(join(__dirname, 'fixtures', 'toy-rocket-seam-ledge.json.gz'))).toString('utf8')) as { positions: number[]; indices: number[] }
    expect(minWall([rocket]).mm).toBeCloseTo(5, 3)
    // the creative eval reads the same wall
    expect(creativeWall([part(rocket)])).toMatchObject({ minWallMm: 5, how: 'every facet' })
  })

  it('a ledge strip 0.004 mm wide reads no wall, and the same 0.004 mm gap under a 5 mm wide face does', () => {
    // a flat strip facing down 5 mm long in ten pieces (each too stubby to be a needle), under a facet 0.004 mm over
    // it that its rays leave through
    const ledge = (wide: number): V[][] => {
      const strip: V[][] = []
      for (let i = 0; i < 10; i++) {
        const a: V = [i * 0.5, 0, 0]
        const b: V = [i * 0.5 + 0.5, 0, 0]
        const c: V = [i * 0.5 + 0.5, wide, 0]
        const d: V = [i * 0.5, wide, 0]
        strip.push([a, c, b], [a, d, c])
      }
      const over: V[] = [[-1, -1, 0.004], [7, -1, 0.004], [3, 7, 0.004]]
      return [...strip, over]
    }
    // the face over the strip reads the 3.004 mm down to the far side
    expect(minWall([mesh([...ledge(0.004), FAR])]).mm).toBeCloseTo(3.004, 4)
    expect(minWall([mesh([...ledge(5), FAR])]).mm).toBeCloseTo(0.004, 4)
  })

  it('a plate 0.004 mm thick and 5 mm wide reads 0.004 mm, also when its top is cut in slivers each under 0.01 mm wide', () => {
    expect(minWall([box(5, 20, 0.004)]).mm).toBeCloseTo(0.004, 4)
    // 500 strips 0.01 mm wide across the top, two facets each, so no facet is wide on its own: together they are one
    // flat patch 5 mm by 2 mm, and its 0.004 mm wall still counts
    const top: V[][] = []
    for (let i = 0; i < 500; i++) {
      const x0 = i * 0.01
      const x1 = (i + 1) * 0.01
      top.push([[x0, 0, 0.004], [x1, 0, 0.004], [x1, 2, 0.004]], [[x0, 0, 0.004], [x1, 2, 0.004], [x0, 2, 0.004]])
    }
    const bottom: V[][] = [[[0, 0, 0], [5, 2, 0], [5, 0, 0]], [[0, 0, 0], [0, 2, 0], [5, 2, 0]]]
    const r = minWall([mesh([...top, ...bottom])])
    expect(r.mm).toBeCloseTo(0.004, 4)
    expect(creativeWall([part(mesh([...top, ...bottom]))]).minWallMm).toBeCloseTo(0.004, 4)
  })

  it('a wedge tapering to a knife edge, whose top and bottom share that edge, reads its thin wall', () => {
    // 10 mm long, 20 mm wide, 0.4 mm tall at x = 0 down to nothing at x = 10
    const p: V[] = [[0, 0, 0], [10, 0, 0], [0, 20, 0], [10, 20, 0], [0, 0, 0.4], [0, 20, 0.4]]
    const [a, b, c, d, e, f] = p as [V, V, V, V, V, V]
    const tris: V[][] = [
      [a, c, b], [b, c, d], // bottom, facing down
      [e, b, d], [e, d, f], // sloped top, facing up
      [a, e, f], [a, f, c], // the 0.4 mm end at x = 0, facing -x
      [a, b, e], // side at y = 0
      [c, f, d], // side at y = 20
    ]
    // each facet's ray starts at its center, so the reading is the wedge's thickness two thirds of the way to the edge,
    // 0.4 x (1 - 2/3): thin, as a knife edge is, and far under twice a 0.4 mm nozzle
    expect(minWall([mesh(tris)]).mm).toBeCloseTo(0.133, 3)
  })

  // a facet's ray goes down from (5, 1.67, 0) and meets a far face `depth` under it, leaving through that face at cosine
  // `cos`: the face stands near upright, as the bore does beside the slanted rim of a swept spout
  const slant = (cos: number, depth: number): V[] => {
    const sin = Math.sqrt(1 - cos * cos)
    const at: V = [5, 5 / 3, -depth]
    const p = (a: number, b: number): V => [at[0] + b * cos, at[1] + a, at[2] + b * sin]
    return [p(-10, -10), p(10, -10), p(0, 10)]
  }
  // a second facet over FAR, beyond the slanted face's reach, whose ray reads a 3 mm wall
  const beside: V[] = [[20, 0, 0], [30, 0, 0], [25, 5, 0]]

  it('a ray leaving almost along a near upright face, as beside the slanted rim of a spout, reads no wall there', () => {
    // the spout's tip cut: its rays read 0.07 to 0.3 mm leaving through the bore at cosines of 0.10 to 0.2
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    expect(minWall([mesh([top, slant(0.15, 0.27), beside, FAR])]).mm).toBeCloseTo(3, 3)
    expect(minWall([mesh([top, slant(0.25, 0.3), beside, FAR])]).mm).toBeCloseTo(3, 3)
  })

  it('a ray leaving a thin floor at a slant, as between a countersink and a bore, still reads the floor', () => {
    // the cable clip's 0.41 mm floor: the far face's normal and the start facet's meet at a cosine of -0.52
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    expect(minWall([mesh([top, slant(0.52, 0.41), beside, FAR])]).mm).toBeCloseTo(0.41, 3)
    expect(minWall([mesh([top, slant(0.7, 0.41), beside, FAR])]).mm).toBeCloseTo(0.41, 3)
  })

  it('a ray leaving through a face that does not face back against its start, as at the open rim of a twisted vase, reads no wall there', () => {
    // a twisted vase with a 2 mm wall: the top face's rays leave through the tilted facets just under the rim, and the
    // two normals meet at cosines of -0.38 to -0.425, reading 0.89 to 0.95 mm. A toy rocket's fin reads 2.13 mm of a 4
    // mm fin the same way at -0.457.
    const top: V[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0]]
    expect(minWall([mesh([top, slant(0.395, 0.886), beside, FAR])]).mm).toBeCloseTo(3, 3)
    expect(minWall([mesh([top, slant(0.425, 0.924), beside, FAR])]).mm).toBeCloseTo(3, 3)
    expect(minWall([mesh([top, slant(0.457, 2.13), beside, FAR])]).mm).toBeCloseTo(3, 3)
    // the creative eval reads it the same way
    expect(creativeWall([part(mesh([top, slant(0.425, 0.924), beside, FAR]))]).minWallMm).toBeCloseTo(3, 3)
  })
})

/** A mesh as the creative eval takes a part. */
const part = (m: { positions: number[]; indices: number[] }) => ({ name: 'Part', slot: 1, positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices) })

/** A closed box from the origin, outward facing, two facets a side. */
function box(x: number, y: number, z: number) {
  const v = (i: number): V => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0]
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
  return mesh(quads.flatMap(([a, b, c, d]) => [[v(a!), v(b!), v(c!)], [v(a!), v(c!), v(d!)]]))
}


/**
 * A closed prism along x, `length` long, of the convex section `yz` (y, z points in order), each side facing out.
 * A model's flared body cut flat at a band line is such a section: wider at the cut than below it.
 */
function prism(yz: [number, number][], length: number) {
  const cy = yz.reduce((s, p) => s + p[0], 0) / yz.length
  const cz = yz.reduce((s, p) => s + p[1], 0) / yz.length
  const out = (t: V[]): V[] => {
    const [a, b, c] = t as [V, V, V]
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]
    const m = [(a[0] + b[0] + c[0]) / 3 - length / 2, (a[1] + b[1] + c[1]) / 3 - cy, (a[2] + b[2] + c[2]) / 3 - cz]
    return n[0]! * m[0]! + n[1]! * m[1]! + n[2]! * m[2]! >= 0 ? t : [a, c, b]
  }
  const tris: V[][] = []
  // in 0.4 mm slices along x, as a model's facets near a cut rim are small
  const xs: number[] = []
  for (let x = 0; x < length - 1e-9; x += 0.4) xs.push(Math.round(x * 10) / 10)
  xs.push(length)
  for (let k = 0; k < yz.length; k++)
    for (let i = 0; i + 1 < xs.length; i++) {
      const [p, q, a, b] = [yz[k]!, yz[(k + 1) % yz.length]!, xs[i]!, xs[i + 1]!]
      tris.push(out([[a, p[0], p[1]], [b, p[0], p[1]], [b, q[0], q[1]]]), out([[a, p[0], p[1]], [b, q[0], q[1]], [a, q[0], q[1]]]))
    }
  for (let k = 1; k + 1 < yz.length; k++)
    for (const x of [0, length]) tris.push(out([[x, yz[0]![0], yz[0]![1]], [x, yz[k]![0], yz[k]![1]], [x, yz[k + 1]![0], yz[k + 1]![1]]]))
  return mesh(tris)
}

/** A section 4 mm wide at its bottom and 14 mm at its flat top 5 mm up, the top cut in 0.1 mm strips toward each rim. */
function flaredSection(): [number, number][] {
  const top: [number, number][] = []
  for (let y = 7; y >= -7 + 1e-9; y -= 0.1) top.push([Math.round(y * 10) / 10, 5])
  return [[-2, 0], [2, 0], ...top, [-7, 5]]
}

describe('the thinnest wall at a sharp edge or point', () => {
  it('a body cut flat at a band line, flaring out to the cut, reads its body, and its knife rim only as a tip', () => {
    // the top's rays near each rim meet the flared side a hair under it, as in a lofted body split at a band line that read
    // 0.04 mm: thin only at the rim, where the side and the cut meet at 45 degrees
    const r = minWall([prism(flaredSection(), 40)])
    expect(r.mm!).toBeGreaterThanOrEqual(0.8)
    expect(r.tip!.mm).toBeLessThan(0.8)
    expect(Math.abs(r.tip!.at[1])).toBeGreaterThan(6.2)
    expect(r.tip!.at[2]).toBeCloseTo(5, 1)
  })

  it('a cone coming to a point reads its body, and the point only as a tip', () => {
    // 30 degrees each side of its axis, in rings 0.2 mm apart toward the point, so the rays near it read under 0.8 mm
    const tris: V[][] = []
    const n = 24
    const H = 8
    const r = (h: number) => (H - h) * Math.tan(Math.PI / 6)
    const ring = (h: number, k: number): V => [r(h) * Math.cos((2 * Math.PI * k) / n), r(h) * Math.sin((2 * Math.PI * k) / n), h]
    const hs: number[] = []
    for (let h = 0; h < H - 2; h += 1) hs.push(h)
    for (let h = H - 2; h < H - 0.1; h += 0.2) hs.push(Math.round(h * 100) / 100)
    for (let i = 0; i + 1 < hs.length; i++)
      for (let k = 0; k < n; k++) {
        const [a, b, c, d] = [ring(hs[i]!, k), ring(hs[i]!, k + 1), ring(hs[i + 1]!, k + 1), ring(hs[i + 1]!, k)]
        tris.push([a, b, c], [a, c, d])
      }
    const last = hs[hs.length - 1]!
    for (let k = 0; k < n; k++) tris.push([ring(last, k), ring(last, k + 1), [0, 0, H]], [[0, 0, 0], ring(0, k + 1), ring(0, k)])
    const w = minWall([mesh(tris)])
    expect(w.mm!).toBeGreaterThanOrEqual(0.8)
    expect(w.tip!.mm).toBeLessThan(0.8)
    expect(w.tip!.at[2]).toBeGreaterThan(H - 0.8)
  })

  it('a real thin wall away from any sharp edge still reads thin: a plate, a strip, and a 0.4 mm skin on a flared body', () => {
    expect(minWall([box(20, 20, 0.4)]).mm).toBeCloseTo(0.4, 3)
    expect(minWall([box(20, 2, 0.4)]).mm).toBeCloseTo(0.4, 3)
    // the flared section, 0.4 mm tall: thin everywhere, not only at its rim
    const skin: [number, number][] = flaredSection().map(([y, z]) => [y, z === 5 ? 0.4 : 0])
    const r = minWall([prism(skin, 40)])
    expect(r.mm!).toBeLessThan(0.8)
  })

  it('takes the tip zone from the nozzle: two nozzle widths', () => {
    // with a 0.2 mm nozzle the floor and the zone are 0.4 mm, so the rim's readings over 0.4 mm count as wall
    const r = minWall([prism(flaredSection(), 40)], undefined, undefined, undefined, 0.2)
    expect(r.tip === undefined || r.tip.mm < 0.4).toBe(true)
  })
})
