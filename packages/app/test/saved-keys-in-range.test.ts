// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A saved project opens in other slicers without a settings error: its project_settings.config carries no value they
// refuse. A filament ironing speed left on automatic (no value, or 0) is left out, since they take only 1 mm/s and up,
// and so is a post-processing script list with no script in it, which they refuse from a project. Reopening the saved
// project gives the same settings to slice with as before it was saved, on the A1 and with no printer.
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'

const { openModelBytes } = await import('../src/state/actions')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { startProjectPrinterSync } = await import('../src/project/project-printer')
const { get, set } = await import('../src/state/store')
const { plateSliceConfig } = await import('../src/state/slice-plate')
const { activeMeta, allPlates } = await import('../src/plate/plates')
const { sx3mfBytes } = await import('../src/export/actions')
const { boxMesh } = await import('../src/plate/mesh-ops')
const { compose } = await import('../src/plate/transform')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ ...handle(name), parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) } } as unknown as Host
const A1 = { id: 'my-a1', vendor: 'Bambu Lab', model: 'A1' }
type Printer = typeof A1 | null

async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    await profileReady()
  }
}

/** A fresh plate on `printer` (none for the generic bed) with `overrides`. */
async function fresh(printer: Printer, overrides: Record<string, unknown> = {}): Promise<void> {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, openNote: null, printerId: printer?.id ?? null, printerModel: printer, overrides: overrides as never, toast: null }))
  startProfileSync()
  startProjectPrinterSync()
  await settled()
}

/** A 20 mm box in the middle of the bed. */
async function addBox(): Promise<void> {
  const bed = get().bed
  const box = { id: 'box', name: 'Box', handle: handle('box'), parts: [{ ...boxMesh(20, 20, 20), name: 'Box' }], colors: ['#bd93f9'], transform: compose({ position: [bed.widthMm / 2, bed.depthMm / 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
  set((s) => ({ plates: [{ ...s.plates[0]!, objects: [box] }], plate: [box] }))
  await settled()
}

/** One entry of a ZIP, stored or deflated. */
function entry(bytes: Uint8Array, want: string): Uint8Array | undefined {
  const b = Buffer.from(bytes)
  let eocd = b.length - 22
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--
  let p = b.readUInt32LE(eocd + 16)
  for (let n = b.readUInt16LE(eocd + 10); n > 0; n--) {
    const nameLen = b.readUInt16LE(p + 28)
    if (b.toString('utf8', p + 46, p + 46 + nameLen) === want) {
      const at = b.readUInt32LE(p + 42)
      const start = at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28)
      const raw = b.subarray(start, start + b.readUInt32LE(p + 20))
      return b.readUInt16LE(p + 10) === 8 ? new Uint8Array(inflateRawSync(raw)) : new Uint8Array(raw)
    }
    p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32)
  }
  return undefined
}
const settingsOf = (bytes: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(entry(bytes, 'Metadata/project_settings.config'))) as Record<string, unknown>
const entries = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v])

/**
 * What other slicers refuse in a project's settings, by key: an ironing speed below the 1 mm/s they take (an empty
 * list reads as 0), or a post-processing list whose only scripts are empty.
 */
const REFUSED: Record<string, (v: unknown) => boolean> = {
  filament_ironing_speed: (v) => entries(v).length === 0 || entries(v).some((x) => !(Number(x) >= 1)),
  post_process: (v) => entries(v).length > 0 && entries(v).every((x) => String(x).trim() === ''),
}

const refused = (settings: Record<string, unknown>): string[] => Object.keys(REFUSED).filter((k) => k in settings && REFUSED[k]!(settings[k]))

describe.each<[string, Printer]>([
  ['the A1', A1],
  ['no printer', null],
])('a project saved on %s', (_name, printer) => {
  it('carries no value other slicers refuse', async () => {
    await fresh(printer)
    await addBox()
    expect(refused(settingsOf(await sx3mfBytes(allPlates(get()))))).toEqual([])
  })

  it('carries none with the ironing speed set to automatic and a post-processing list of one empty script', async () => {
    await fresh(printer, { filament_ironing_speed: [0], post_process: [''] })
    await addBox()
    expect(refused(settingsOf(await sx3mfBytes(allPlates(get()))))).toEqual([])
  })

  it('reopens with the same settings to slice with', async () => {
    await fresh(printer)
    await addBox()
    const before = plateSliceConfig(get(), activeMeta(get()))
    const bytes = await sx3mfBytes(allPlates(get()))
    await fresh(printer)
    await openModelBytes(host, 'box.sx3mf', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, undefined, { fresh: true })
    await settled()
    expect(get().plate.map((p) => p.name)).toEqual(['Box'])
    expect(get().overrides).toEqual({})
    expect(plateSliceConfig(get(), activeMeta(get()))).toEqual(before)
  })
})
