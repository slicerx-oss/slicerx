// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A saved project keeps each plate's own plate type where other apps read it: the plate's <plate> entry in
// Metadata/model_settings.config carries it as `bed_type`, and as `curr_bed_type` with the same value, which older
// SlicerX files carry. A plate on the default plate type writes neither. The app's reader and the geometry engine's
// read each plate's type back from the saved file.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { projectOf, readProjectsWithGeom, scanProjectFile } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { unzipStored } from '../src/export/zip'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { setGeomProvider } from '../src/geom/client'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { BedType } from '../src/plate/bed-type'
import type { PlateEntry, PlateMeta } from '../src/state/store'
import { wasmBuilt } from './geom-engine'

const BED = { widthMm: 256, depthMm: 256 }
const wasm = process.env['SX_GEOM_CORE_WASM'] ?? join(__dirname, '..', '..', '..', 'packages/geom/wasm/pkg/sx_geom_core.wasm')

/** Each plate type, the name a project file gives it, and the plate type the app reads that name back as. */
const TYPES: [BedType, string, BedType][] = [
  ['cool', 'Cool Plate', 'cool'],
  ['engineering', 'Engineering Plate', 'engineering'],
  ['high-temp', 'High Temp Plate', 'smooth-pei'],
  ['textured-pei', 'Textured PEI Plate', 'textured-pei'],
  ['smooth-pei', 'High Temp Plate', 'smooth-pei'],
  ['textured-cool', 'Textured Cool Plate', 'textured-cool'],
  ['supertack', 'Supertack Plate', 'supertack'],
]

function box(id: string): PlateEntry {
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] } as MeshHandle
  return { id, name: id, handle, parts: [{ ...boxMesh(20, 20, 20), name: id, slot: 1 }], colors: ['#fff'], transform: compose({ position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

/** One plate per plate type, then a plate on the default plate type (no type of its own). */
const plates: PlateMeta[] = [
  ...TYPES.map(([bedType], i) => ({ id: `p${i + 1}`, name: `Plate ${i + 1}`, objects: [box(`b${i + 1}`)], settings: { bedType } })),
  { id: 'p8', name: 'Default', objects: [box('b8')], settings: {} },
]
const bytes = writeProject({ plates, bed: BED, settings: { curr_bed_type: 'Textured PEI Plate' } })

/** Each plate entry's own metadata (outside its object instances), by plate number. */
function plateMeta(file: Uint8Array): Record<string, string>[] {
  const cfg = new TextDecoder().decode(unzipStored(file).get('Metadata/model_settings.config'))
  return [...cfg.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => Object.fromEntries([...m[1]!.replace(/<model_instance>[\s\S]*?<\/model_instance>/g, '').matchAll(/<metadata key="([^"]*)" value="([^"]*)"\/>/g)].map((k) => [k[1]!, k[2]!])))
}

describe("a saved project keeps each plate's plate type where other apps read it", () => {
  it('writes bed_type and curr_bed_type with the same name in each plate entry, for every plate type', () => {
    const meta = plateMeta(bytes)
    expect(meta).toHaveLength(8)
    TYPES.forEach(([type, name], i) => {
      expect({ type, bed_type: meta[i]!['bed_type'], curr_bed_type: meta[i]!['curr_bed_type'] }).toEqual({ type, bed_type: name, curr_bed_type: name })
    })
  })

  it('writes neither for a plate on the default plate type', () => {
    const meta = plateMeta(bytes)[7]!
    expect(meta['plater_name']).toBe('Default')
    expect(meta).not.toHaveProperty('bed_type')
    expect(meta).not.toHaveProperty('curr_bed_type')
  })

  it("reads each plate's type back from the saved file", async () => {
    readProjectsWithGeom(false)
    setGeomProvider(null)
    const read = await projectOf(await scanProjectFile(bytes), BED)
    expect(read.plates.map((p) => p.bedType)).toEqual([...TYPES.map(([, , back]) => back), undefined])
  })
})

describe.skipIf(!wasmBuilt(wasm))("the geometry engine reads each saved plate's type back", async () => {
  const instance = existsSync(wasm) ? (await WebAssembly.instantiate(readFileSync(wasm), {})).instance : null
  const x = instance?.exports as unknown as GeomExports
  afterAll(() => {
    setGeomProvider(null)
    readProjectsWithGeom(true)
  })
  it('as the app reader does', async () => {
    readProjectsWithGeom(true)
    setGeomProvider({ call: async <T,>(op: string, request: unknown) => callEngine(x, op, request) as T })
    const scanned = await scanProjectFile(bytes)
    expect(scanned.parsedIn).toBe('geom')
    const read = await projectOf(scanned, BED)
    expect(read.plates.map((p) => p.bedType)).toEqual([...TYPES.map(([, , back]) => back), undefined])
  })
})
