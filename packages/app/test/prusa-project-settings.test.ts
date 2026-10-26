// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A PrusaSlicer project's own settings as the app opens them, against the shared cases in @slicerx/settings
// fixtures/prusa-project-settings.json that sx-core (sx project-settings, sx slice <project.3mf>) and the MCP server run
// too: the open applies exactly the case's values on top of the current settings, and they go to the engine as such.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue, SliceRequest } from '@slicerx/contracts'
import { importFlat, sameValue } from '@slicerx/settings'
import { baseConfig, resolveConfig } from '../src/adapters/config'
import { readProject } from '../src/export/import3mf'
import { projectSettingChanges } from '../src/export/project-settings'
import { zip } from '../src/export/zip'
import { openModelBytes, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const fixtures = join(__dirname, '../../settings/fixtures')
type Case = { name: string; files?: string[]; lines?: string[]; config: Record<string, unknown>; unmapped: string[] }
const cases = (JSON.parse(readFileSync(join(fixtures, 'prusa-project-settings.json'), 'utf8')) as { cases: Case[] }).cases
const bed = { widthMm: 250, depthMm: 210 }

const model = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">PrusaSlicer-2.9.6</metadata><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'

/** Each project a case stands for: its files, or one built from its lines as a project writes them. */
async function projects(c: Case): Promise<{ name: string; bytes: Uint8Array }[]> {
  if (!c.lines) return (c.files ?? []).map((f) => ({ name: f.replace(/^.*\//, ''), bytes: new Uint8Array(readFileSync(join(fixtures, f))) }))
  const bytes = await zip([{ name: '3D/3dmodel.model', data: model }, { name: 'Metadata/Slic3r_PE.config', data: c.lines.map((l) => `; ${l}`).join('\n') }])
  return [{ name: 'case.3mf', bytes }]
}

/** The case's values in the app's settings shapes, as the engine and the MCP server take them. */
const expected = (c: Case): Record<string, SettingValue> => importFlat(c.config).config as unknown as Record<string, SettingValue>

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

describe("the app's open of a PrusaSlicer project", () => {
  for (const c of cases) {
    it(`${c.name}: the settings the engine reads`, async () => {
      for (const p of await projects(c)) {
        const project = await readProject(p.bytes, bed)
        expect(project.settingsFrom).toBe('prusaslicer')
        const base = baseConfig() as unknown as Record<string, SettingValue>
        const { values } = projectSettingChanges(project.settings, baseConfig())
        // What it changes is the case's, and the case's values are what it ends with: the same as the engine's.
        const want = expected(c)
        for (const k of Object.keys(values)) expect(k in want, k).toBe(true)
        for (const [k, v] of Object.entries(want)) expect(values[k] ?? base[k], k).toEqual(v)
      }
    })
  }

  it('sends the T slab to the engine with its settings', async () => {
    const c = cases[0]!
    const { host, requests } = engine()
    await openModelBytes(host, 'tslab.3mf', buf(new Uint8Array(readFileSync(join(fixtures, 'preset-files/prusaslicer-2.9.6-tslab.3mf')))), undefined, { fresh: true })
    await slicePlate(host, { auto: true })
    expect(requests).toHaveLength(1)
    const sent = requests[0]!.config as Record<string, SettingValue>
    const cfg = resolveConfig(get().easy, get().overrides) as Record<string, SettingValue>
    for (const [k, v] of Object.entries(expected(c))) {
      expect(sameValue(cfg[k], v), `${k}: ${JSON.stringify(cfg[k])}`).toBe(true)
      if (k in sent) expect(sameValue(sent[k], v), `${k} sent: ${JSON.stringify(sent[k])}`).toBe(true)
    }
    expect(sent['enable_support']).toBe(true)
    expect(sent['wall_loops']).toBe(3)
  })
})
