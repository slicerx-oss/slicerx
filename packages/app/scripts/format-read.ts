// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's own readers on one file of the format corpus, for scripts/format-corpus/run.mjs: the 3MF project reader
// (export/import3mf.ts, the same scan the project worker runs) and the binary STL scan (export/stl-scan.ts). OBJ, AMF,
// ASCII STL and STEP open through the geometry engine in the app, so they are sx-geom's rows, not this reader's.
//
//   pnpm --filter @slicerx/store exec tsx ../app/scripts/format-read.ts <file|--none> [repeats]
//
// Prints one JSON summary in the shape of packages/core/examples/format_read.rs. The project reader parses the small
// settings files with DOMParser, which Node lacks; jsdom's stands in, and it is slower than a browser's, so the times
// here are an upper bound for the 3MF rows.
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { JSDOM } from 'jsdom'

Object.assign(globalThis, { DOMParser: new JSDOM('').window.DOMParser })
const { readProject } = await import('../src/export/import3mf')
const { scanStl } = await import('../src/export/stl-scan')
type ImportedObject = import('../src/export/import3mf').ImportedObject
type ImportedProject = import('../src/export/import3mf').ImportedProject

const [file, reps] = process.argv.slice(2)
if (!file) {
  console.error('usage: format-read.ts <file|--none> [repeats]')
  process.exit(2)
}
const repeats = Math.max(1, Number(reps) || 3)
const BED = { widthMm: 256, depthMm: 256 }
const LAYERS = ['color', 'seam', 'support', 'fuzzy'] as const

type Extent = { lo: number[]; hi: number[] } | null

function grow(e: Extent, positions: ArrayLike<number>, m?: number[]): Extent {
  for (let i = 0; i + 2 < positions.length; i += 3) {
    let p = [positions[i]!, positions[i + 1]!, positions[i + 2]!]
    // column-major 4x4
    if (m) p = [0, 1, 2].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!)
    if (!e) e = { lo: [...p], hi: [...p] }
    for (let k = 0; k < 3; k++) {
      e.lo[k] = Math.min(e.lo[k]!, p[k]!)
      e.hi[k] = Math.max(e.hi[k]!, p[k]!)
    }
  }
  return e
}

const size = (e: Extent) => (e ? e.hi.map((h, k) => Math.round((h - e.lo[k]!) * 100) / 100) : [0, 0, 0])

function objectOf(o: ImportedObject) {
  let ext: Extent = null
  const parts = o.parts.map((p, i) => {
    ext = grow(ext, p.positions, o.transform)
    const paint = o.paint?.[i] ?? {}
    return {
      name: p.name,
      type: 'normal',
      slot: p.slot,
      triangles: p.indices.length / 3,
      paint: Object.fromEntries(LAYERS.map((l) => [l, Object.keys(paint[l] ?? {}).length])),
    }
  })
  const volumes = o.volumes.map((v) => ({
    name: v.name,
    type: v.role === 'negative' ? 'negative' : v.role,
    slot: v.part.slot,
    triangles: v.part.indices.length / 3,
    paint: { color: 0, seam: 0, support: 0, fuzzy: 0 },
  }))
  return { name: o.name, extent: size(ext), parts: [...parts, ...volumes] }
}

function summary(p: ImportedProject) {
  const source = p.plates.flatMap((pl) => pl.objects).find((o) => o.source)?.source
  return {
    plates: p.plates.map((pl, i) => ({ plate: i + 1, objects: pl.objects.map(objectOf) })),
    meta: { settingsKeys: Object.keys(p.settings), settingsFrom: p.settingsFrom, sx: source ? { listing: source.modelId ?? null, creator: source.creatorId ?? null } : null },
  }
}

async function read(bytes: Uint8Array, name: string): Promise<unknown> {
  const ext = extname(name).toLowerCase()
  if (ext === '.3mf' || ext === '.sx3mf') return summary(await readProject(bytes, BED))
  if (ext === '.stl') {
    const s = scanStl(bytes)
    // an ASCII STL goes to sx-geom in the app, so this reader has nothing of its own to say
    if (!s) return null
    const parts = [{ name: basename(name), type: 'normal', slot: 1, triangles: s.indices.length / 3, paint: { color: 0, seam: 0, support: 0, fuzzy: 0 } }]
    return { plates: [{ plate: 1, objects: [{ name: basename(name), extent: size(grow(null, s.positions)), parts }] }], meta: {} }
  }
  throw new Error(`the app reads ${ext} files through sx-geom`)
}

const times: number[] = []
let out: { ok: true; model: unknown } | { ok: false; error: string } = { ok: true, model: null }
if (file !== '--none') {
  const bytes = new Uint8Array(readFileSync(file))
  for (let r = 0; r < repeats; r++) {
    const t = performance.now()
    try {
      out = { ok: true, model: await read(bytes, basename(file)) }
    } catch (e) {
      out = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    times.push(performance.now() - t)
    if (!out.ok) break
  }
}
console.log(JSON.stringify({ reader: 'app', ...out, firstMs: times[0] ?? 0, minMs: times.length ? Math.min(...times) : 0 }))
