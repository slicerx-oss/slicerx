// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Vault starters other than the layered X: what each one is, its filament color and how it is built. Sizes in mm,
// Z up, centered on the origin, standing on z = 0. Each comes out as one closed body.
import type { MeshPart } from '@slicerx/contracts'
import { boxMesh } from '../src/plate/mesh-ops'
import { arc, box, cut, cylinder, extrudeZ, type Geom, label, place, prism, type Pt, screwHole, union } from './starter-geom'

export interface Starter {
  slug: string
  title: string
  description: string
  tags: string[]
  parts: MeshPart[]
  colors: string[]
  /** The listing version this build is. */
  version: string
  /** Custom G-code by height, written to the file's custom_gcode_per_layer.xml. */
  marks?: { z: number; kind: 'custom'; gcode: string }[]
}

type Make = (geom: Geom) => Starter

const one = (m: MeshPart, name: string): MeshPart[] => [{ ...m, name, slot: 1 }]

/** 20 mm cube with X, Y and Z cut into the faces square to each axis. */
const cube: Make = (geom) => {
  let c = place(boxMesh(20, 20, 20), [0, 0, 0])
  c = label(geom, c, 'X', [10, 0, 10], [1, 0, 0], [0, 0, 1], 10)
  c = label(geom, c, 'Y', [0, -10, 10], [0, -1, 0], [0, 0, 1], 10)
  c = label(geom, c, 'Z', [0, 0, 20], [0, 0, 1], [0, 1, 0], 10)
  return {
    slug: 'calibration-cube-20mm',
    title: '20 mm calibration cube',
    description: 'A 20 mm cube with X, Y and Z cut into the faces square to each axis. Measure from each letter to the face opposite it with calipers to check steps per mm and shrinkage.',
    tags: ['calibration', 'functional'],
    parts: one(c, 'Cube'),
    colors: ['#8be9fd'],
    version: '1.1.0',
  }
}

/**
 * Wall hook, printed on its side so the layers run along the load: a back plate with two countersunk screw holes and
 * a cup that holds about 18 mm.
 */
const hook: Make = (geom) => {
  const w = 16
  // The side profile: back plate x 0 to 4, cup centered at (13, 13) with walls 4 thick, lip up to y 20.
  const outline: Pt[] = [
    [0, 56],
    [0, 13],
    ...arc(13, 13, 13, Math.PI, 2 * Math.PI, 24).slice(1),
    [26, 20],
    [22, 20],
    ...arc(13, 13, 9, 0, -Math.PI, 18),
    [4, 56],
  ]
  let h = extrudeZ(geom, outline, 0, w)
  // Screws go in from the cup side (x = 4) into the wall behind (x = 0).
  h = cut(geom, h, [...screwHole([4, 30, w / 2], 'x', -1, 4), ...screwHole([4, 48, w / 2], 'x', -1, 4)])
  h = place(h, [-13, -28, 0])
  return {
    slug: 'wall-hook',
    title: 'Wall hook',
    description: 'A hook with a back plate and two countersunk holes for 4 mm screws. It prints on its side so the layers run along the load.',
    tags: ['functional', 'home'],
    parts: one(h, 'Hook'),
    colors: ['#ffb86c'],
    version: '1.1.0',
  }
}

/** Cable clip for a 6 mm cable: a C ring opening away from a flat foot with two countersunk holes for 3 mm screws. */
const clip: Make = (geom) => {
  const tall = 8
  // The ring: 6.4 mm inside, 2 mm wall, open 4.8 mm at the top so a 6 mm cable snaps in.
  const half = Math.asin(2.4 / 3.2)
  const from = Math.PI / 2 + half
  const to = Math.PI / 2 - half + 2 * Math.PI
  const ring = extrudeZ(geom, [...arc(0, 0, 5.2, from, to, 40), ...arc(0, 0, 3.2, to, from, 32)], 0, tall)
  // The foot reaches 0.8 mm into the ring, so they are one piece.
  const foot = box([-14, -7.6, 0], [14, -4.4, tall])
  let c = union(geom, 'Cable clip', [ring, foot])
  c = cut(geom, c, [...screwHole([-10, -4.4, tall / 2], 'y', -1, 3.2, 3.2, 6.2), ...screwHole([10, -4.4, tall / 2], 'y', -1, 3.2, 3.2, 6.2)])
  return {
    slug: 'cable-clip',
    title: 'Cable clip',
    description: 'A snap clip for a 6 mm cable. The ring opens away from a flat foot with two countersunk holes for 3 mm screws, or use tape.',
    tags: ['functional', 'home', 'desk'],
    parts: one(c, 'Cable clip'),
    colors: ['#50fa7b'],
    version: '1.1.0',
  }
}

/** Shelf bracket printed on its side: two 60 mm arms, a diagonal gusset and countersunk holes in both arms. */
const bracket: Make = (geom) => {
  const w = 16
  const t = 6
  const l = union(geom, 'Bracket', [
    extrudeZ(geom, [[0, 0], [60, 0], [60, t], [t, t], [t, 60], [0, 60]], 0, w),
    // The gusset: a 6 mm strut from 46 mm up the wall arm to 46 mm along the shelf arm.
    extrudeZ(geom, [[t - 1, 46 - 4], [46 - 4, t - 1], [46 + 4, t - 1], [t - 1, 46 + 4]], 0, w),
  ])
  // Wall arm holes go in along -X from the inside face, shelf arm holes along -Y.
  const holes = [...screwHole([t, 22, w / 2], 'x', -1, t), ...screwHole([t, 55, w / 2], 'x', -1, t), ...screwHole([22, t, w / 2], 'y', -1, t), ...screwHole([55, t, w / 2], 'y', -1, t)]
  const b = place(cut(geom, l, holes), [-30, -30, 0])
  return {
    slug: 'shelf-bracket',
    title: 'Shelf bracket',
    description: 'A 60 mm shelf bracket with a diagonal gusset and two countersunk holes for 4 mm screws in each arm. It prints on its side, so print it with more walls for strength.',
    tags: ['functional', 'home'],
    parts: one(b, 'Shelf bracket'),
    colors: ['#ff79c6'],
    version: '1.1.0',
  }
}

/** Fins leaning 20 to 70 degrees from vertical on one base, each with its angle cut into the base in front of it. */
const overhang: Make = (geom) => {
  const angles = [20, 30, 40, 50, 60, 70]
  const fins = angles.map((deg, i) => {
    const h = 12
    const lean = h * Math.tan((deg * Math.PI) / 180)
    // A 4 mm slab, 8 mm wide, leaning back (toward +Y) from y = -5.
    return place(prism('yz', [[-5, 2], [-1, 2], [-1 + lean, 2 + h], [-5 + lean, 2 + h]], 8), [-35 + i * 14, 0, 0])
  })
  let o = union(geom, 'Overhang test', [box([-44, -14, 0], [44, 2, 2]), ...fins])
  angles.forEach((deg, i) => {
    o = label(geom, o, String(deg), [-35 + i * 14, -10.5, 2], [0, 0, 1], [0, 1, 0], 5)
  })
  return {
    slug: 'overhang-test',
    title: 'Overhang test',
    description: 'Six fins leaning out at 20, 30, 40, 50, 60 and 70 degrees from vertical, with each angle cut into the base in front of it. Shows the steepest overhang your cooling handles without supports.',
    tags: ['calibration', 'overhang', 'cooling'],
    parts: one(o, 'Overhang test'),
    colors: ['#8be9fd'],
    version: '1.1.0',
  }
}

/** Bridges of 10 to 50 mm between pillars, each row on a thin strip joined by a spine, its span raised on its deck. */
const bridging: Make = (geom) => {
  const spans = [10, 20, 30, 40, 50]
  const base = 0.6
  const left = -26
  const pieces: MeshPart[] = []
  const rows = spans.map((_, i) => -26 + i * 13)
  // The spine: 6 mm wide down the left end, under every row.
  pieces.push(box([left - 6, rows[0]! - 4, 0], [left, rows[rows.length - 1]! + 4, base]))
  spans.forEach((span, i) => {
    const y = rows[i]!
    const right = left + 6 + span
    pieces.push(
      box([left, y - 4, 0], [right + 6, y + 4, base]),
      box([left, y - 4, base], [left + 6, y + 4, 10 + base]),
      box([right, y - 4, base], [right + 6, y + 4, 10 + base]),
      box([left, y - 4, 10 + base], [right + 6, y + 4, 11.2 + base]),
    )
  })
  let b = union(geom, 'Bridging test', pieces)
  spans.forEach((span, i) => {
    b = label(geom, b, String(span), [left + 6 + span / 2, rows[i]!, 11.2 + base], [0, 0, 1], [0, 1, 0], 5, 'emboss', 0.6)
  })
  b = place(b, [-2, 0, 0])
  return {
    slug: 'bridging-test',
    title: 'Bridging test',
    description: 'Five bridges from 10 to 50 mm long between pillars on a thin base, each with its span raised on top. Look underneath to see how far your printer bridges cleanly.',
    tags: ['calibration', 'bridging', 'cooling'],
    parts: one(b, 'Bridging test'),
    colors: ['#50fa7b'],
    version: '1.1.0',
  }
}

/** Four thin towers 25 mm apart on a thin strip, so every layer travels between them. Unchanged but for its color. */
const retraction: Make = (geom) => {
  const r = union(geom, 'Retraction test', [box([-45, -7, 0], [45, 7, 1]), ...[-37.5, -12.5, 12.5, 37.5].map((x) => cylinder([x, 0, 1], 5, 30, 3))])
  return {
    slug: 'retraction-test',
    title: 'Retraction and stringing test',
    description: 'Four 5 mm towers on a thin base with long travels between them. Tune retraction length and speed until the gaps stay clean.',
    tags: ['calibration', 'retraction', 'stringing'],
    parts: one(r, 'Retraction test'),
    colors: ['#ffb86c'],
    version: '1.1.0',
  }
}

/** Five 0.2 mm squares across the bed. Separate pieces on purpose, far apart. Unchanged but for its color. */
const firstLayer: Make = () => ({
  slug: 'first-layer-test',
  title: 'First layer test',
  description: 'Five 0.2 mm squares across the bed, one in the middle and one in each corner of a 180 mm area. Check squish and adhesion everywhere at once.',
  tags: ['calibration', 'first-layer'],
  parts: [{ ...box([-20, -20, 0], [20, 20, 0.2]), name: 'Middle', slot: 1 }, ...[[-70, -70], [70, -70], [70, 70], [-70, 70]].map(([x, y], i) => ({ ...box([x! - 15, y! - 15, 0], [x! + 15, y! + 15, 0.2]), name: `Corner ${i + 1}`, slot: 1 }))],
  colors: ['#f8f8f2'],
  version: '1.1.0',
})

/** PLA temperatures, bottom floor first. */
const TOWER_C = [230, 225, 220, 215, 210, 205, 200]
const FLOOR = 10
const PLINTH = 1

/**
 * Temperature tower for PLA: seven 10 mm floors from 230 down to 200 C. Each floor has its temperature cut into the
 * front, a 12 mm bridge, a 45 degree overhang on the left and a 30 degree one on the right (from horizontal), a cone in
 * the bridge opening for stringing, and a notch where it meets the next floor. The file carries an M104 at the start of
 * every floor, so the slice changes temperature with no step from the person.
 */
const tower: Make = (geom) => {
  const d = 12
  const pieces: MeshPart[] = [box([-28, -10, 0], [26, 10, PLINTH])]
  const notches: MeshPart[] = []
  const slope30 = 5 * Math.tan(Math.PI / 6)
  TOWER_C.forEach((_, i) => {
    const z = PLINTH + i * FLOOR
    pieces.push(
      box([-17, -d / 2, z], [-3, d / 2, z + FLOOR]),
      box([9, -d / 2, z], [17, d / 2, z + FLOOR]),
      // The bridge, 12 mm across the opening between the two blocks.
      box([-3, -d / 2, z + 8], [9, d / 2, z + FLOOR]),
      // 45 degrees on the left, 30 degrees on the right, both from horizontal.
      prism('xz', [[-17, z + 1], [-17, z + FLOOR], [-24, z + FLOOR], [-24, z + 8]], d),
      prism('xz', [[17, z + 8 - slope30], [22, z + 8], [22, z + FLOOR], [17, z + FLOOR]], d),
      // The stringing cone stands in the opening, clear of the bridge above it.
      cylinder([3, 0, z], 4, 6, 0.8),
    )
    // A V notch round the front and back where each floor meets the one above.
    if (i > 0) for (const side of [-1, 1]) notches.push(prism('yz', side < 0 ? [[-d / 2 - 0.1, z - 0.6], [-d / 2 + 0.6, z], [-d / 2 - 0.1, z + 0.6]] : [[d / 2 + 0.1, z - 0.6], [d / 2 + 0.1, z + 0.6], [d / 2 - 0.6, z]], 50))
  })
  let t = cut(geom, union(geom, 'Temperature tower', pieces), notches)
  TOWER_C.forEach((c, i) => {
    t = label(geom, t, String(c), [-10, -d / 2, PLINTH + i * FLOOR + 4.5], [0, -1, 0], [0, 0, 1], 4.5)
  })
  return {
    slug: 'temperature-tower',
    title: 'Temperature tower',
    description: 'Seven 10 mm floors for PLA from 230 down to 200 C, each labeled with its temperature, with a 12 mm bridge, 45 and 30 degree overhangs and a stringing cone. The temperature changes are in the file, so it slices ready to print. Pick the floor that looks best.',
    tags: ['calibration', 'temperature'],
    parts: one(t, 'Temperature tower'),
    colors: ['#ff79c6'],
    version: '1.1.0',
    marks: TOWER_C.map((c, i) => ({ z: PLINTH + i * FLOOR, kind: 'custom' as const, gcode: `M104 S${c}` })),
  }
}

/** In listing order after the layered X. */
export const STARTERS: readonly Make[] = [cube, hook, clip, bracket, firstLayer, overhang, bridging, retraction, tower]
