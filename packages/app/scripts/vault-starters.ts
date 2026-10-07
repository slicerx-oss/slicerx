// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds the Vault's starter models in code: the app's example models and a set
// of calibration prints, each as an .sx3mf with a cover drawn from its
// triangles, plus the manifest for packages/store/scripts/seed-library.ts.
// Everything is original geometry made here. The output folder must sit
// outside git, like every seed folder.
//
//   pnpm --filter @slicerx/store exec tsx ../app/scripts/vault-starters.ts <out folder>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { MeshPart } from '@slicerx/contracts'
import { renderCover } from '../src/export/cover'
import { writeProject } from '../src/export/threemf'
import { DEMO_MODELS } from '../src/lib/demo-models'
import { bake, boxMesh, cylinderMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { PlateEntry } from '../src/state/store'

const out = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('usage: vault-starters.ts <out folder>')
mkdirSync(out, { recursive: true })

const at = (part: MeshPart, x: number, y: number, z = 0, name = part.name, slot = 1): MeshPart => ({ ...bake(part, compose({ position: [x, y, z], rotation: [0, 0, 0], scale: [1, 1, 1] })), name, slot })

/** Turns the triangles to face outward: a mesh whose signed volume is negative is inside out. */
function outward(m: MeshPart): MeshPart {
  let v = 0
  const P = m.positions
  for (let i = 0; i + 2 < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i]! * 3, m.indices[i + 1]! * 3, m.indices[i + 2]! * 3]
    v += P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!) - P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!) + P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!)
  }
  if (v >= 0) return m
  const ix = new Uint32Array(m.indices.length)
  for (let i = 0; i + 2 < ix.length; i += 3) {
    ix[i] = m.indices[i]!
    ix[i + 1] = m.indices[i + 2]!
    ix[i + 2] = m.indices[i + 1]!
  }
  return { ...m, indices: ix }
}

/** The same prism with its outline in the YZ plane, `depth` wide along X. */
function prismYZ(name: string, outline: [number, number][], depth: number): MeshPart {
  const m = prismXZ(name, outline, depth)
  const p = new Float32Array(m.positions.length)
  for (let i = 0; i + 2 < p.length; i += 3) {
    p[i] = m.positions[i + 1] ?? 0
    p[i + 1] = m.positions[i] ?? 0
    p[i + 2] = m.positions[i + 2] ?? 0
  }
  // Swapping two axes mirrors the mesh, so the winding flips back.
  const ix = new Uint32Array(m.indices.length)
  for (let i = 0; i + 2 < ix.length; i += 3) {
    ix[i] = m.indices[i] ?? 0
    ix[i + 1] = m.indices[i + 2] ?? 0
    ix[i + 2] = m.indices[i + 1] ?? 0
  }
  return outward({ ...m, positions: p, indices: ix })
}

/** A prism from a convex outline in the XZ plane, `depth` deep along Y and centered on it. */
function prismXZ(name: string, outline: [number, number][], depth: number): MeshPart {
  const n = outline.length
  const p: number[] = []
  for (const [x, z] of outline) p.push(x, -depth / 2, z)
  for (const [x, z] of outline) p.push(x, depth / 2, z)
  const ix: number[] = []
  for (let i = 1; i + 1 < n; i++) ix.push(0, i, i + 1, n, n + i + 1, n + i)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    ix.push(i, n + i, j, j, n + i, n + j)
  }
  return outward({ name, slot: 1, positions: new Float32Array(p), indices: new Uint32Array(ix) })
}

interface Starter {
  slug: string
  title: string
  description: string
  tags: string[]
  parts: MeshPart[]
  colors: string[]
}

const starters: Starter[] = []

const DEMO_TEXT: Record<string, { title: string; description: string; tags: string[] }> = {
  'x-mark': { title: 'Layered X', description: 'The SlicerX mark on a plinth, in two colors. A short first print to check a new printer and a filament swap.', tags: ['calibration', 'multicolor', 'functional'] },
  'calibration-cube': { title: '20 mm calibration cube', description: 'A plain 20 mm cube. Measure X, Y and Z with calipers to check steps per mm and shrinkage.', tags: ['calibration', 'functional'] },
  'wall-hook': { title: 'Wall hook', description: 'A simple hook that prints on its side so the layers run along the load. Screw or tape it to a wall.', tags: ['functional', 'home'] },
  'cable-clip': { title: 'Cable clip', description: 'Snap fit clip for a 6 mm cable, with a flat foot for tape or a screw.', tags: ['functional', 'home', 'desk'] },
  'shelf-bracket': { title: 'Shelf bracket', description: 'A gusseted shelf bracket. Print it with strong settings and more walls.', tags: ['functional', 'home'] },
}
for (const m of DEMO_MODELS) {
  const t = DEMO_TEXT[m.slug]
  if (!t) continue
  const built = m.build()
  starters.push({ slug: m.slug === 'calibration-cube' ? 'calibration-cube-20mm' : m.slug, ...t, parts: built.parts, colors: built.colors })
}

// First layer test: a large square in the middle and four in the corners, one layer at 0.2 mm.
starters.push({
  slug: 'first-layer-test',
  title: 'First layer test',
  description: 'Five 0.2 mm squares across the bed, one in the middle and one in each corner of a 180 mm area. Check squish and adhesion everywhere at once.',
  tags: ['calibration', 'first-layer'],
  parts: [at(boxMesh(40, 40, 0.2), 0, 0, 0, 'Middle'), ...[[-70, -70], [70, -70], [70, 70], [-70, 70]].map(([x, y], i) => at(boxMesh(30, 30, 0.2), x!, y!, 0, `Corner ${i + 1}`))],
  colors: ['#f8f8f2'],
})

// Overhang test: fins leaning forward at 20 to 70 degrees from vertical, side by side on a base.
const fins = [20, 30, 40, 50, 60, 70].map((deg, i) => {
  const h = 12
  const lean = h * Math.tan((deg * Math.PI) / 180)
  return at(prismYZ(`${deg} degrees`, [[0, 0], [4, 0], [4 + lean, h], [lean, h]], 8), -35 + i * 14, 0)
})
starters.push({
  slug: 'overhang-test',
  title: 'Overhang test',
  description: 'Six fins leaning out at 20, 30, 40, 50, 60 and 70 degrees on a base. Shows the steepest overhang your cooling handles without supports.',
  tags: ['calibration', 'overhang', 'cooling'],
  parts: [at(boxMesh(90, 14, 2), 0, 2, 0, 'Base'), ...fins.map((f) => at(f, 0, -5, 2))],
  colors: ['#8be9fd'],
})

// Bridging test: pairs of pillars with 10, 20, 30, 40 and 50 mm spans.
const spans = [10, 20, 30, 40, 50]
const bridgeParts: MeshPart[] = [at(boxMesh(70, 66, 1.6), 0, 0, 0, 'Base')]
spans.forEach((span, i) => {
  const y = -26 + i * 13
  bridgeParts.push(at(boxMesh(6, 8, 10), -span / 2 - 3, y, 1.6, `Pillar ${span} left`), at(boxMesh(6, 8, 10), span / 2 + 3, y, 1.6, `Pillar ${span} right`), at(boxMesh(span + 12, 8, 1.2), 0, y, 11.6, `Bridge ${span} mm`))
})
starters.push({
  slug: 'bridging-test',
  title: 'Bridging test',
  description: 'Five bridges from 10 to 50 mm long between pillars. Look underneath to see how far your printer bridges cleanly.',
  tags: ['calibration', 'bridging', 'cooling'],
  parts: bridgeParts,
  colors: ['#50fa7b'],
})

// Retraction test: four thin towers 25 mm apart, so every layer travels between them.
starters.push({
  slug: 'retraction-test',
  title: 'Retraction and stringing test',
  description: 'Four 5 mm towers on a thin base with long travels between them. Tune retraction length and speed until the gaps stay clean.',
  tags: ['calibration', 'retraction', 'stringing'],
  parts: [at(boxMesh(90, 14, 1), 0, 0, 0, 'Base'), ...[-37.5, -12.5, 12.5, 37.5].map((x, i) => at(cylinderMesh(5, 30, 32, 3), x, 0, 1, `Tower ${i + 1}`))],
  colors: ['#ffb86c'],
})

// Temperature tower: six 10 mm floors, each with an overhang fin and a short bridge, for six temperatures.
const floors: MeshPart[] = [at(boxMesh(44, 14, 1), 0, 0, 0, 'Base')]
for (let i = 0; i < 6; i++) {
  const z = 1 + i * 10
  floors.push(
    at(boxMesh(10, 10, 9), -12, 0, z, `Floor ${i + 1} left`),
    at(boxMesh(10, 10, 9), 12, 0, z, `Floor ${i + 1} right`),
    at(boxMesh(34, 10, 1), 0, 0, z + 9, `Floor ${i + 1} bridge`),
    // A 45 degree wedge hanging off the outer face of the left pillar.
    at(prismXZ(`Floor ${i + 1} overhang`, [[-17, 1], [-17, 9], [-25, 9]], 10), 0, 0, z),
  )
}
starters.push({
  slug: 'temperature-tower',
  title: 'Temperature tower',
  description: 'Six 10 mm floors, each with a bridge and a 45 degree overhang. Add a temperature change at every floor and pick the one that looks best.',
  tags: ['calibration', 'temperature'],
  parts: floors,
  colors: ['#ff79c6'],
})

/** A PNG from RGBA, for the covers. */
function png(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = (crcTable[(c ^ x) & 255] ?? 0) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const bed = { widthMm: 256, depthMm: 256 }
const listings = []
for (const s of starters) {
  const entry = { id: s.slug, name: s.title, handle: { id: s.slug, hash: s.slug, name: s.title, triangles: 0, bboxMm: [0, 0, 0], openEdges: 0, parts: [] }, parts: s.parts, colors: s.colors, transform: compose({ position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) } as unknown as PlateEntry
  const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [entry], settings: { sequence: 'by-layer' } }], bed, settings: {}, sx: { exportedBy: '' } })
  writeFileSync(join(out, `${s.slug}.sx3mf`), bytes)
  const cover = renderCover(s.parts.map((p) => ({ positions: p.positions, indices: p.indices, color: s.colors[p.slot - 1] ?? s.colors[0] ?? '#bd93f9' })), 800, 600)
  writeFileSync(join(out, `${s.slug}.png`), png(cover.width, cover.height, cover.rgba))
  listings.push({ creator: 'slicerx', slug: s.slug, title: s.title, description: s.description, license: 'cc0', tags: s.tags, version: '1.0.0', file: `${s.slug}.sx3mf`, cover: `${s.slug}.png` })
  console.log(`${s.slug}.sx3mf  ${(bytes.length / 1024).toFixed(0)} KB`)
}

const manifest = {
  creators: [
    {
      handle: 'slicerx',
      email: 'vault@slicerx.app',
      displayName: 'SlicerX',
      tagline: 'Starter and calibration prints',
      bio: 'Free test prints to dial in a new printer or filament, made by the SlicerX team. Everything here is CC0, so print, change and share it however you like.',
      trusted: true,
      links: [{ kind: 'website', label: 'slicerx.app', url: 'https://slicerx.app' }],
      featured: ['first-layer-test', 'calibration-cube-20mm', 'temperature-tower'],
    },
  ],
  listings,
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`${listings.length} starters and manifest.json in ${out}`)
