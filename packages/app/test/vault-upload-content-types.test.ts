// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Vault upload passes the upload check's content type rule: a project declares the binary type
// (application/octet-stream) only when it holds the design history's .bin meshes, and the upload leaves the history
// out. The upload check's own test reads the checked-in fixture this test keeps current; SX_UPLOAD_FIXTURE=1 writes it
// again from the app's upload packing.
import type { MeshHandle } from '@slicerx/contracts'
import type { History } from '@slicerx/cad-history'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { currentProjectUpload } from '../src/export/upload-source'
import { writeProject } from '../src/export/threemf'
import { unzipEntries } from '../src/export/unzip'
import { unzipStored } from '../src/export/zip'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { set } from '../src/state/store'
import type { PlateEntry, PlateMeta } from '../src/state/store'

const FIXTURE = join(import.meta.dirname, '../../../editions/slicerx/packages/cloud/scan/tests/fixtures/app-upload.sx3mf')
const OCTET = 'application/octet-stream'
const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const box = boxMesh(20, 20, 20)
// A body made in the design tools: its history holds the base mesh, which the file stores as a .bin part.
const history: History = { version: 1, base: [{ name: box.name, slot: 1, positions: box.positions, indices: box.indices }], steps: [] }
const entry = (withHistory: boolean): PlateEntry => ({
  id: 'obj_a',
  name: 'Bracket',
  handle: handle('a'),
  parts: [box],
  colors: ['#bd93f9'],
  transform: compose({ position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
  ...(withHistory ? { history } : {}),
})
const plates = (e: PlateEntry): PlateMeta[] => [{ id: 'p1', name: 'Plate 1', objects: [e], settings: { sequence: 'by-layer' } }]
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b)

describe('content types follow the parts', () => {
  it('a project with no .bin parts declares no binary type', () => {
    const files = unzipStored(writeProject({ plates: plates(entry(false)), bed, settings: {} }))
    expect([...files.keys()].some((n) => n.endsWith('.bin'))).toBe(false)
    expect(text(files.get('[Content_Types].xml'))).not.toContain(OCTET)
  })

  it('a project with the design history keeps its .bin parts and declares them', () => {
    const files = unzipStored(writeProject({ plates: plates(entry(true)), bed, settings: {} }))
    expect([...files.keys()].some((n) => n.endsWith('.bin'))).toBe(true)
    expect(text(files.get('[Content_Types].xml'))).toContain(`<Default Extension="bin" ContentType="${OCTET}"/>`)
  })

  it('history: false writes the meshes without the history', () => {
    const files = unzipStored(writeProject({ plates: plates(entry(true)), bed, settings: {}, history: false }))
    const names = [...files.keys()]
    expect(names.some((n) => n.endsWith('.bin') || n.startsWith('Metadata/slicerx_history'))).toBe(false)
    expect(names).toContain('3D/3dmodel.model')
    expect(text(files.get('[Content_Types].xml'))).not.toContain(OCTET)
  })
})

describe('the Vault upload', () => {
  it('packs the project without the history, as the checked-in fixture has it', async () => {
    const e = entry(true)
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', plate: [e], slice: { status: 'idle' }, objectSettings: {}, overrides: {}, layerMarks: {}, namedValues: [] })
    const up = await currentProjectUpload()
    expect(up).not.toBeNull()
    const files = await unzipEntries(up!.bytes)
    const names = [...files.keys()].sort()
    expect(names.some((n) => n.endsWith('.bin') || n.startsWith('Metadata/slicerx_history'))).toBe(false)
    const types = text(files.get('[Content_Types].xml'))
    expect(types).not.toContain(OCTET)
    if (process.env['SX_UPLOAD_FIXTURE']) writeFileSync(FIXTURE, up!.bytes)
    // The fixture the upload check is tested on matches what the app sends now.
    expect(existsSync(FIXTURE)).toBe(true)
    const fixture = await unzipEntries(new Uint8Array(readFileSync(FIXTURE)))
    expect([...fixture.keys()].sort()).toEqual(names)
    expect(text(fixture.get('[Content_Types].xml'))).toBe(types)
  })
})
