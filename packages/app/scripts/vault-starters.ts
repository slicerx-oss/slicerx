// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds the Vault's starter models in code: the app's layered X and a set of calibration and household prints, each
// as an .sx3mf with its filament colors and a cover drawn from its triangles, plus the manifest for
// packages/store/scripts/seed-library.ts. Everything is original geometry made here. Every model is one closed body
// (sx-geom joins the pieces and cuts the labels), so it slices without touch notes. The output folder must sit outside
// git, like every seed folder. Build the geometry engine first (packages/geom/wasm/scripts/build.sh).
//
//   pnpm --filter @slicerx/store exec tsx ../app/scripts/vault-starters.ts <out folder> [--demo-meshes]
//
// --demo-meshes also writes packages/app/src/lib/demo-meshes.ts: the app's built-in wall hook, cable clip and
// shelf bracket, the same bodies as the starters, so the examples in the app match the Vault.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { renderCover } from '../src/export/cover'
import { writeProject } from '../src/export/threemf'
import { DEMO_MODELS } from '../src/lib/demo-models'
import { compose } from '../src/plate/transform'
import type { PlateEntry } from '../src/state/store'
import { loadGeom } from './starter-geom'
import { STARTERS, type Starter } from './starter-parts'

const out = resolve(process.argv[2] ?? '')
const demoMeshes = process.argv.includes('--demo-meshes')
if (!process.argv[2]) throw new Error('usage: vault-starters.ts <out folder>')
mkdirSync(out, { recursive: true })

const geom = await loadGeom()
const starters: Starter[] = []
const xMark = DEMO_MODELS.find((m) => m.slug === 'x-mark')
if (xMark) {
  const built = await xMark.build()
  starters.push({ slug: 'x-mark', title: 'Layered X', description: 'The SlicerX mark on a plinth, in two colors. A short first print to check a new printer and a filament swap.', tags: ['calibration', 'multicolor', 'functional'], parts: built.parts, colors: built.colors, version: '1.1.0', changelog: 'The filament colors are in the file.' })
}
for (const make of STARTERS) starters.push(make(geom))

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
  // The filament colors go in as Orca writes them, so the app, the Vault and other slicers show them.
  const layerMarks = s.marks?.length ? { 0: s.marks } : undefined
  const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [entry], settings: { sequence: 'by-layer' } }], bed, settings: { filament_colour: s.colors }, ...(layerMarks ? { layerMarks } : {}), sx: { exportedBy: '' } })
  writeFileSync(join(out, `${s.slug}.sx3mf`), bytes)
  const cover = renderCover(s.parts.map((p) => ({ positions: p.positions, indices: p.indices, color: s.colors[p.slot - 1] ?? s.colors[0] ?? '#bd93f9' })), 800, 600)
  // Each version's cover has a name of its own, so a new version never overwrites the cover the old one used.
  const coverFile = `${s.slug}-${s.version}.png`
  writeFileSync(join(out, coverFile), png(cover.width, cover.height, cover.rgba))
  listings.push({ creator: 'slicerx-team', slug: s.slug, title: s.title, description: s.description, license: 'cc0', tags: s.tags, version: s.version, changelog: s.changelog, file: `${s.slug}.sx3mf`, cover: coverFile })
  console.log(`${s.slug}.sx3mf  ${(bytes.length / 1024).toFixed(0)} KB`)
}

const manifest = {
  creators: [
    {
      handle: 'slicerx-team',
      email: 'vault@slicerx.app',
      displayName: 'SlicerX',
      tagline: 'Starter and calibration prints',
      bio: 'Free test prints to dial in a new printer or filament, made by the SlicerX team. Everything here is CC0, so print, change and share it however you like.',
      trusted: true,
      links: [{ kind: 'website', label: 'slicerx.app', url: 'https://slicerx.app' }],
      featured: ['first-layer-test', 'calibration-cube-20mm', 'temperature-tower'],
      // The creator logo is drawn by hand; put slicerx-logo.png in the folder and the manifest names it.
      ...(existsSync(join(out, 'slicerx-logo.png')) ? { logo: 'slicerx-logo.png' } : {}),
    },
  ],
  listings,
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`${listings.length} starters and manifest.json in ${out}`)

if (demoMeshes) {
  const b64 = (a: Float32Array | Uint32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64')
  const lines = (['wall-hook', 'cable-clip', 'shelf-bracket'] as const).map((slug) => {
    const s = starters.find((x) => x.slug === slug)
    const p = s?.parts[0]
    if (!s || !p) throw new Error(`no ${slug}`)
    return `  '${slug}': { name: '${p.name}', color: '${s.colors[0]}', positions: '${b64(p.positions)}', indices: '${b64(p.indices)}' },`
  })
  const file = join(import.meta.dirname, '../src/lib/demo-meshes.ts')
  writeFileSync(
    file,
    `// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Written by scripts/vault-starters.ts --demo-meshes; do not edit. The built-in wall hook, cable clip and shelf
// bracket as the Vault starters build them: one closed body each, Float32 positions (mm) and Uint32 triangle
// indices, little endian, in base64. Loaded on demand, not at startup.
export const DEMO_MESHES: Readonly<Record<string, { name: string; color: string; positions: string; indices: string }>> = {
${lines.join('\n')}
}
`,
  )
  console.log(`wrote ${file}`)
}
