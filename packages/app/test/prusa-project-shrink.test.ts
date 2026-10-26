// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A PrusaSlicer project writes no shrinkage as 0%, where SlicerX's no shrinkage is 100%, and a first layer infill speed
// of 0 for "use the first layer speed". Read as is, the engine scales every part 100 times and refuses the plate. Both
// fixtures are 2.9.6 projects saved with those defaults: the cube with a modifier and a T slab.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue, SliceRequest } from '@slicerx/contracts'
import { baseConfig, resolveConfig } from '../src/adapters/config'
import { readProject } from '../src/export/import3mf'
import { projectSettingChanges } from '../src/export/project-settings'
import { unzipEntries } from '../src/export/unzip'
import { zip } from '../src/export/zip'
import { openModelBytes, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, '../../settings/fixtures/preset-files', name)))
const FILES = ['prusaslicer-2.9.6.3mf', 'prusaslicer-2.9.6-tslab.3mf']
const bed = { widthMm: 250, depthMm: 210 }

/** The fixture with its Slic3r_PE.config line for `key` set to `value`. */
async function withValue(name: string, key: string, value: string): Promise<Uint8Array> {
  const files = await unzipEntries(fixture(name))
  const text = new TextDecoder().decode(files.get('Metadata/Slic3r_PE.config')!)
  const next = text.replace(new RegExp(`^; ${key} = .*$`, 'm'), `; ${key} = ${value}`)
  expect(next).not.toBe(text)
  return zip([...files].map(([n, data]) => ({ name: n, data: n === 'Metadata/Slic3r_PE.config' ? next : data })))
}

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })

/** A host whose slice records each request and stops there. */
function engine(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const slice = async (r: SliceRequest) => {
    requests.push(r)
    throw new Error('stop')
  }
  return { host: { kind: 'web', capabilities: { threads: 1 }, slicer: { slice, loadParts: async (name: string) => handle(name) } } as unknown as Host, requests }
}
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

beforeEach(async () => {
  set((s) => ({ openNote: null, plate: [], plates: s.plates.map((p) => ({ ...p, objects: [] })), overrides: {}, projectSettings: null, projectGcode: null, resume: null, calibration: {}, layerMarks: {}, slice: { status: 'idle' }, toast: null }))
  await profileReady()
})

describe('a PrusaSlicer project saved with no shrinkage', () => {
  for (const name of FILES) {
    it(`${name} reads as no shrinkage and the first layer infill speed from the first layer speed`, async () => {
      const p = await readProject(fixture(name), bed)
      expect(p.settingsFrom).toBe('prusaslicer')
      expect(p.settingsNote).toBeUndefined()
      const { values } = projectSettingChanges(p.settings, baseConfig())
      const effective = { ...baseConfig(), ...values } as Record<string, SettingValue>
      expect(effective['filament_shrink']).toEqual([100])
      expect(effective['filament_shrinkage_compensation_z']).toEqual([100])
      // first_layer_speed 50% of infill_speed 200
      expect(effective['initial_layer_infill_speed']).toEqual([100])
    })

    it(`${name} opens and goes to the engine with no shrinkage`, async () => {
      const { host, requests } = engine()
      await openModelBytes(host, name, buf(fixture(name)), undefined, { fresh: true })
      const cfg = resolveConfig(get().easy, get().overrides) as Record<string, SettingValue>
      expect(cfg['filament_shrink']).toEqual([100])
      expect(cfg['filament_shrinkage_compensation_z']).toEqual([100])
      expect(cfg['initial_layer_infill_speed']).toEqual([100])
      expect(get().openNote?.text ?? '').not.toMatch(/shrink/i)
      await slicePlate(host, { auto: true })
      expect(requests).toHaveLength(1)
      const sent = requests[0]!.config as Record<string, SettingValue>
      expect(sent['filament_shrink']).toEqual([100])
      expect(sent['filament_shrinkage_compensation_z']).toEqual([100])
    })
  }
})

describe('a PrusaSlicer project with shrinkage set', () => {
  it('leaves the shrinkage out and says so in plain words', async () => {
    const bytes = await withValue('prusaslicer-2.9.6-tslab.3mf', 'filament_shrinkage_compensation_xy', '0.5%')
    const p = await readProject(bytes, bed)
    expect(p.settings['filament_shrink']).toBeUndefined()
    expect(p.settingsNote).toBe('Not applied from its settings: shrinkage compensation XY.')
    const { host } = engine()
    await openModelBytes(host, 'shrunk.3mf', buf(bytes), undefined, { fresh: true })
    const text = get().openNote?.text ?? ''
    expect(text).toContain('Not applied from its settings: shrinkage compensation XY.')
    expect(text).toMatch(/^Applied \d+ settings from shrunk\.3mf\. /)
    expect(text).not.toMatch(/filament_shrink|_xy/)
    expect((resolveConfig(get().easy, get().overrides) as Record<string, SettingValue>)['filament_shrink']).toEqual([100])
  })
})
