// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project reader on the geometry engine (geom-project.ts) against the TypeScript reader, on every 3MF of the format
// corpus (packages/geom/tests/corpus/corpus.json): the same plates, objects, parts, volumes, slots, paint and settings,
// and the same meshes to a thousandth of a millimeter. Needs the engine built (packages/geom/wasm/scripts/build.sh, or
// SX_GEOM_CORE_WASM); without it the test is skipped. SX_CORPUS_PRIVATE=<dir> adds the 3MF files in a folder outside
// the repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { setGeomProvider } from '../src/geom/client'
import { projectOf, readProjectsWithGeom, scanProjectFile, type ImportedProject } from '../src/export/import3mf'

const root = join(__dirname, '..', '..', '..')
const wasm = process.env['SX_GEOM_CORE_WASM'] ?? join(root, 'packages/geom/wasm/pkg/sx_geom_core.wasm')
const BED = { widthMm: 256, depthMm: 256 }

/** Where the readers differ on purpose: the TypeScript reader leaves out PrusaSlicer's paint. */
const EXPECTED: Record<string, string[]> = { 'prusa-painted.3mf': ['paint'] }

function files(): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'packages/geom/tests/corpus/corpus.json'), 'utf8')) as { files: { path: string }[] }
  const out = manifest.files.map((f) => join(root, f.path)).filter((p) => /\.s?x?3mf$/i.test(p))
  const dir = process.env['SX_CORPUS_PRIVATE']
  if (dir) out.push(...readdirSync(dir).filter((n) => /\.3mf$/i.test(n)).sort().map((n) => join(dir, n)))
  return out
}

/** Every difference between two readings of a project, by kind. */
function compare(a: ImportedProject, b: ImportedProject): Map<string, string> {
  const out = new Map<string, string>()
  const note = (kind: string, what: string) => {
    if (!out.has(kind)) out.set(kind, what)
  }
  if (a.plates.length !== b.plates.length) note('plates', `${a.plates.length} / ${b.plates.length}`)
  if (JSON.stringify(Object.keys(a.settings).sort()) !== JSON.stringify(Object.keys(b.settings).sort())) note('settings', 'keys')
  a.plates.forEach((pa, i) => {
    const pb = b.plates[i]
    if (!pb) return
    if (pa.name !== pb.name || pa.sequence !== pb.sequence || JSON.stringify(pa.nozzleMap) !== JSON.stringify(pb.nozzleMap)) note('plate', `${pa.name} / ${pb.name}`)
    if (pa.objects.length !== pb.objects.length) return note('objects', `${pa.objects.length} / ${pb.objects.length}`)
    pa.objects.forEach((oa, j) => {
      const ob = pb.objects[j]!
      if (oa.name !== ob.name) note('object name', `${oa.name} / ${ob.name}`)
      if (oa.fileId !== ob.fileId || oa.printable !== ob.printable) note('object', `${oa.fileId} / ${ob.fileId}`)
      if (oa.transform.some((v, k) => Math.abs(v - ob.transform[k]!) > 1e-3)) note('transform', `${oa.transform.join(' ')} / ${ob.transform.join(' ')}`)
      if (JSON.stringify(oa.source) !== JSON.stringify(ob.source)) note('source', `${JSON.stringify(oa.source)} / ${JSON.stringify(ob.source)}`)
      if (JSON.stringify(oa.rawPartSettings ?? {}) !== JSON.stringify(ob.rawPartSettings ?? {})) note('part settings', `${JSON.stringify(oa.rawPartSettings)} / ${JSON.stringify(ob.rawPartSettings)}`)
      const paint = (p?: Record<number, Record<string, Record<number, string>>>) => JSON.stringify(Object.entries(p ?? {}).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort().map(([l, t]) => [l, Object.keys(t).length]))]))
      if (paint(oa.paint) !== paint(ob.paint)) note('paint', `${paint(oa.paint)} / ${paint(ob.paint)}`)
      const meshes = (o: typeof oa) => [...o.parts.map((p) => ({ ...p, role: 'part' })), ...o.volumes.map((v) => ({ ...v.part, role: v.role, raw: v.rawSettings }))]
      const ma = meshes(oa)
      const mb = meshes(ob)
      if (ma.length !== mb.length) return note('parts', `${ma.length} / ${mb.length}`)
      ma.forEach((p, k) => {
        const q = mb[k]!
        if (p.name !== q.name) note('part name', `${p.name} / ${q.name}`)
        if (p.role !== q.role || p.slot !== q.slot) note('part', `${p.role} ${p.slot} / ${q.role} ${q.slot}`)
        if (p.indices.length !== q.indices.length || p.positions.length !== q.positions.length) return note('mesh size', `${p.indices.length} / ${q.indices.length}`)
        if (p.indices.some((v, n) => v !== q.indices[n])) note('triangles', p.name)
        let worst = 0
        for (let n = 0; n < p.positions.length; n++) worst = Math.max(worst, Math.abs(p.positions[n]! - q.positions[n]!))
        if (worst > 1e-3) note('positions', `${p.name} off by ${worst}`)
      })
    })
  })
  return out
}

describe.skipIf(!existsSync(wasm))('the geometry engine reads 3MF projects as the TypeScript reader does', async () => {
  const instance = existsSync(wasm) ? (await WebAssembly.instantiate(readFileSync(wasm), {})).instance : null
  const x = instance?.exports as unknown as GeomExports
  afterAll(() => {
    setGeomProvider(null)
    readProjectsWithGeom(true)
  })
  for (const file of files()) {
    const name = file.split('/').pop()!
    it(name, async () => {
      const bytes = new Uint8Array(readFileSync(file))
      readProjectsWithGeom(false)
      setGeomProvider(null)
      const ts = await projectOf(await scanProjectFile(bytes), BED)
      readProjectsWithGeom(true)
      setGeomProvider({ call: async <T,>(op: string, request: unknown) => callEngine(x, op, request) as T })
      const scanned = await scanProjectFile(bytes)
      expect(scanned.parsedIn).toBe('geom')
      const geom = await projectOf(scanned, BED)
      const diff = compare(ts, geom)
      for (const k of EXPECTED[name] ?? []) diff.delete(k)
      expect(Object.fromEntries(diff)).toEqual({})
    })
  }
})
