// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Designs from the Vault leave only as .sx3mf: no STL or OBJ export, through the export function, the commands (and so
// the menu and the command bar) or after splitting, cutting or merging; the Vault tag survives a save and a reopen.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshHandle, SliceResult } from '@slicerx/contracts'
import { isVaultFile, refuseVaultFile } from '../../mcp/src/vault'
import { exportAllPlates, exportGcode3mf, printGcode3mf } from '../src/export/actions'
import { readProject, unzipEntries } from '../src/export/import3mf'
import { exportMesh, meshExportBytes } from '../src/export/mesh'
import { projectFiles, writeProject } from '../src/export/threemf'
import { zip } from '../src/export/zip'
import { fromVault, VAULT_SX3MF_ONLY } from '../src/export/vault'
import { plateCommands } from '../src/plate/commands'
import { mergeSelected, splitSelectedToObjects } from '../src/plate/edit'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { openModelBytes } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'

// Slicing is the engine's job; here every plate slices to the same result.
vi.mock('../src/state/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/state/actions')>()),
  slicePlate: async () => set({ slice: { status: 'done', result: { id: 'r1' } as never, stale: false } }),
}))

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const place = (x: number) => compose({ position: [x, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const VAULT = { modelId: '11111111-1111-4111-8111-111111111111', creatorId: '22222222-2222-4222-8222-222222222222' }
const own = (id: string, x = 50): PlateEntry => ({ id, name: id, handle: handle(id), parts: [boxMesh(20, 20, 20)], colors: ['#bd93f9'], transform: place(x) })
const vault = (id: string, x = 120): PlateEntry => ({ ...own(id, x), source: VAULT })
const host = (saved: string[]) => ({ files: { save: async (n: string) => (saved.push(n), { id: n, name: n, size: 1 }) } }) as unknown as Host
const loader = { loadParts: async (name: string) => handle(name) }

beforeEach(() => set({ plate: [own('mine'), vault('vault')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', selection: 'vault', selectedIds: ['vault'], toast: null }))

describe('Vault designs and mesh export', () => {
  it('tells a Vault object from your own', () => {
    expect(fromVault([own('a')])).toBe(false)
    expect(fromVault([own('a'), vault('b')])).toBe(true)
    expect(fromVault([{ source: { creatorId: 'x' } }])).toBe(false)
  })

  it('refuses STL and OBJ for a selected Vault object, and for a plate holding one', async () => {
    const saved: string[] = []
    expect(await exportMesh(host(saved), 'selection', 'stl')).toBe(false)
    expect(get().toast?.text).toBe(VAULT_SX3MF_ONLY)
    expect(await exportMesh(host(saved), 'selection', 'obj')).toBe(false)
    expect(await exportMesh(host(saved), 'plate', 'stl')).toBe(false)
    expect(saved).toEqual([])
    expect(() => meshExportBytes([vault('v')], 'stl')).toThrow(VAULT_SX3MF_ONLY)
  })

  it('still exports your own objects', async () => {
    const saved: string[] = []
    set({ selection: 'mine', selectedIds: ['mine'] })
    expect(await exportMesh(host(saved), 'selection', 'stl')).toBe(true)
    expect(saved).toEqual(['mine.stl'])
  })

  it('turns the export commands off, so the menu and the command bar cannot reach them', () => {
    const cmds = plateCommands(() => 'slicerx' as never, host([]))
    const enabled = (id: string) => cmds.find((c) => c.id === id)?.enabled?.() ?? true
    for (const id of ['export-selection-stl', 'export-selection-obj', 'export-plate-stl', 'export-plate-obj']) expect(enabled(id), id).toBe(false)
    set({ plate: [own('mine')], selection: 'mine', selectedIds: ['mine'] })
    for (const id of ['export-selection-stl', 'export-selection-obj', 'export-plate-stl', 'export-plate-obj']) expect(enabled(id), id).toBe(true)
  })

  it('keeps the Vault tag through split and merge', async () => {
    const two = { ...vault('v2'), parts: [boxMesh(10, 10, 10), { ...boxMesh(10, 10, 10), positions: boxMesh(10, 10, 10).positions.map((p, i) => (i % 3 === 0 ? p + 40 : p)) }] }
    set({ plate: [two], selection: 'v2', selectedIds: ['v2'] })
    expect(await splitSelectedToObjects(loader)).toBeGreaterThan(1)
    expect(get().plate.every((p) => p.source?.modelId === VAULT.modelId)).toBe(true)
    set({ plate: [own('mine'), vault('vault')], selection: 'mine', selectedIds: ['mine', 'vault'] })
    expect(await mergeSelected(loader)).toBe(true)
    expect(get().plate).toHaveLength(1)
    expect(get().plate[0]?.source?.modelId).toBe(VAULT.modelId)
  })
})

describe('the Vault tag in .sx3mf files', () => {
  const bed = { widthMm: 256, depthMm: 256 }
  it('comes back on reopen from the root model, as the library stamps it', async () => {
    const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [own('a')], settings: { sequence: 'by-layer' } }], bed, settings: {}, sx: { ...VAULT, exportedBy: '' } })
    const back = await readProject(bytes, bed)
    const objects = back.plates.flatMap((p) => p.objects)
    expect(objects.length).toBeGreaterThan(0)
    expect(objects.every((o) => o.source?.modelId === VAULT.modelId)).toBe(true)
  })

  it('leaves a file without sx:Listing untagged', async () => {
    const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [own('a')], settings: { sequence: 'by-layer' } }], bed, settings: {}, sx: { exportedBy: '' } })
    const back = await readProject(bytes, bed)
    expect(back.plates.flatMap((p) => p.objects).some((o) => o.source?.modelId)).toBe(false)
  })
})

describe('reading the Vault marks as XML', () => {
  const bed = { widthMm: 256, depthMm: 256 }
  const ID = VAULT.modelId
  /** A plain project with its model part and settings changed. */
  function crafted(edit: { model?: (xml: string) => string; settings?: (xml: string) => string }): Uint8Array {
    const files = projectFiles({ plates: [{ id: 'p1', name: 'Plate 1', objects: [own('a')], settings: { sequence: 'by-layer' } }], bed, settings: {} })
    return zip(files.map((f) => (f.name === '3D/3dmodel.model' && edit.model ? { ...f, data: edit.model(String(f.data)) } : f.name === 'Metadata/model_settings.config' && edit.settings ? { ...f, data: edit.settings(String(f.data)) } : f)))
  }
  const tagged = async (bytes: Uint8Array) => (await readProject(bytes, bed)).plates.flatMap((p) => p.objects).every((o) => o.source?.modelId === ID)
  const root = (meta: string) => (x: string) => x.replace('<resources>', `${meta}<resources>`)
  const onObject = (meta: string) => (x: string) => x.replace(/(<object id="\d+">)/, `$1${meta}`)

  it('on the root model: single quotes, an attribute before name, another prefix, after 1 MB', async () => {
    expect(await tagged(crafted({ model: root(`<metadata name='sx:Listing'>${ID}</metadata>`) }))).toBe(true)
    expect(await tagged(crafted({ model: root(`<metadata type="xs:string" name="sx:Listing">${ID}</metadata>`) }))).toBe(true)
    expect(await tagged(crafted({ model: (x) => root(`<metadata name="v:Listing">${ID}</metadata>`)(x).replace('<model ', '<model xmlns:v="https://slicerx.app/schemas/sx3mf/2026" ') }))).toBe(true)
    const filler = '<metadata name="Description">filler filler filler filler</metadata>'.repeat(20_000)
    expect(filler.length).toBeGreaterThan(1 << 20)
    expect(await tagged(crafted({ model: root(`${filler}<metadata name="sx:Listing">${ID}</metadata>`) }))).toBe(true)
  })

  it('on an object: single quotes, value before key, an attribute before key, after 1 MB', async () => {
    expect(await tagged(crafted({ settings: onObject(`<metadata key='sx:Listing' value='${ID}'/>`) }))).toBe(true)
    expect(await tagged(crafted({ settings: onObject(`<metadata value="${ID}" key="sx:Listing"/>`) }))).toBe(true)
    expect(await tagged(crafted({ settings: onObject(`<metadata note="x" key="sx:Listing" value="${ID}"/>`) }))).toBe(true)
    const filler = '<metadata key="note" value="filler filler filler filler"/>'.repeat(25_000)
    expect(await tagged(crafted({ settings: onObject(`${filler}<metadata key="sx:Listing" value="${ID}"/>`) }))).toBe(true)
  })

  it('takes nothing from a comment or another name, and refuses a DTD', async () => {
    const bytes = crafted({ model: root(`<!-- <metadata name="sx:Listing">${ID}</metadata> --><metadata name="sx:Version">1.0.0</metadata>`) })
    expect((await readProject(bytes, bed)).plates.flatMap((p) => p.objects).some((o) => o.source?.modelId)).toBe(false)
    const dtd = crafted({ settings: (x) => x.replace('<config>', '<!DOCTYPE config [<!ENTITY l "Listing">]><config>') })
    await expect(readProject(dtd, bed)).rejects.toThrow(/DTD/)
  })
})

describe('print output made from a Vault design', () => {
  const GCODE = ['; HEADER_BLOCK_START', '; model label id: 1', '; HEADER_BLOCK_END', '; start printing object, unique label id: 1', 'G1 X60 Y60', 'G1 X80 Y80 E1', '; stop printing object, unique label id: 1', ''].join('\n')
  const result = { id: 'r1', engine: 'sx', layerCount: 10, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 600, filamentMm: [100], filamentG: [3], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [] } as SliceResult
  const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)
  const printHost = (saved: { name: string; blob: Blob }[]) =>
    ({
      kind: 'web',
      capabilities: { threads: 1 },
      files: { save: async (name: string, blob: Blob) => (saved.push({ name, blob }), { id: name, name, size: blob.size }) },
      slicer: {
        exportGcode: async () => ({ fileName: 'plate.gcode', bytes: GCODE.length, sha256: '', blob: new Blob([GCODE]) }),
        loadParts: async (name: string) => handle(name),
      },
    }) as unknown as Host
  const sliced = (plate: PlateEntry[]) => set({ plate, selection: null, selectedIds: [], slice: { status: 'done', result, stale: false }, toast: null })

  it('carries sx:Listing on the root model and on each object, in .gcode.3mf and in the file sent to a printer', async () => {
    sliced([vault('vault', 60)])
    const saved: { name: string; blob: Blob }[] = []
    expect(await exportGcode3mf(printHost(saved))).toBe(true)
    expect(saved[0]?.name).toMatch(/\.gcode\.3mf$/)
    for (const bytes of [new Uint8Array(await saved[0]!.blob.arrayBuffer()), await printGcode3mf(GCODE)]) {
      const files = await unzipEntries(bytes)
      expect(dec(files.get('3D/3dmodel.model'))).toContain(`<metadata name="sx:Listing">${VAULT.modelId}</metadata>`)
      expect(dec(files.get('Metadata/model_settings.config'))).toContain(`<metadata key="sx:Listing" value="${VAULT.modelId}"/>`)
      expect(files.has('Metadata/plate_1.gcode')).toBe(true)
    }
  })

  it('marks only the Vault object on a plate that mixes it with your own, in every plate export', async () => {
    sliced([own('mine', 40), vault('vault', 140)])
    const saved: { name: string; blob: Blob }[] = []
    expect(await exportAllPlates(printHost(saved))).toBe(true)
    const files = await unzipEntries(new Uint8Array(await saved[0]!.blob.arrayBuffer()))
    expect(dec(files.get('3D/3dmodel.model'))).not.toContain('name="sx:Listing"')
    const back = await readProject(new Uint8Array(await saved[0]!.blob.arrayBuffer()), { widthMm: 256, depthMm: 256 })
    expect(back.plates.flatMap((p) => p.objects).map((o) => o.source?.modelId ?? null)).toEqual([null, VAULT.modelId])
  })

  it('leaves print output from your own designs without sx: metadata', async () => {
    sliced([own('mine', 60)])
    const files = await unzipEntries(await printGcode3mf(GCODE))
    expect(dec(files.get('3D/3dmodel.model'))).not.toContain('sx:')
    expect(dec(files.get('Metadata/model_settings.config'))).not.toContain('sx:')
  })

  it('round trips: a sliced Vault design exported as .gcode.3mf opens as a Vault design, STL export stays off and the MCP refuses it', async () => {
    sliced([vault('vault', 60)])
    const saved: { name: string; blob: Blob }[] = []
    const h = printHost(saved)
    expect(await exportGcode3mf(h)).toBe(true)
    const bytes = await saved[0]!.blob.arrayBuffer()
    set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', selection: null, selectedIds: [] })
    await openModelBytes(h, 'vault.gcode.3mf', bytes)
    const opened = get().plate
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every((o) => o.source?.modelId === VAULT.modelId)).toBe(true)
    set({ selection: opened[0]!.id, selectedIds: [opened[0]!.id] })
    const out: string[] = []
    expect(await exportMesh(host(out), 'selection', 'stl')).toBe(false)
    expect(await exportMesh(host(out), 'plate', 'obj')).toBe(false)
    expect(out).toEqual([])
    const cmds = plateCommands(() => 'slicerx' as never, host([]))
    expect(cmds.find((c) => c.id === 'export-plate-stl')?.enabled?.()).toBe(false)
    const path = join(mkdtempSync(join(tmpdir(), 'sx-vault-')), 'vault.gcode.3mf')
    writeFileSync(path, new Uint8Array(bytes))
    expect(isVaultFile(path)).toBe(true)
    expect(() => refuseVaultFile(path)).toThrow(/design from the Vault/)
  })
})
