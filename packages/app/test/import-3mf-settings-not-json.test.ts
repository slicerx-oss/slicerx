// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project whose print settings file is not JSON settings still opens, and never loses them without a word: an empty
// or blank file is a 3MF without settings, JSON after a byte order mark is read as usual, and key = value lines, a
// cut-off file, garbage or JSON that is not an object are left out with a note the open shows.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { readProject } from '../src/export/import3mf'
import { zip } from '../src/export/zip'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { openModelBytes } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const BOM = String.fromCharCode(0xfeff)
const JSON_SETTINGS = '{\n  "layer_height": "0.3",\n  "filament_colour": ["#FF0000"]\n}\n'
const INI = '; an older export\n\n[print]\nlayer_height = 0.3\nnozzle_diameter = 0.4,0.4\n'
const OLDER = 'Its print settings were left out because they are in an older key = value format, so it opens with the current settings.'
const DAMAGED = 'Its print settings were left out because its settings file is damaged, so it opens with the current settings.'

const vertices = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="box" type="model"><mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${triangles.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 30 40 0"/></build></model>`

/** The box as a 3MF, with `settings` as its project settings file when given. */
function box(settings?: string | Uint8Array): Uint8Array {
  return zip([{ name: '3D/3dmodel.model', data: MODEL }, ...(settings === undefined ? [] : [{ name: 'Metadata/project_settings.config', data: settings }])])
}
const bed = { widthMm: 256, depthMm: 256 }
const at = async (bytes: Uint8Array) => Array.from((await readProject(bytes, bed)).plates[0]!.objects[0]!.transform.slice(12, 15))

describe('project settings that are not JSON, as the file is read', () => {
  it('reads an empty or blank file as a 3MF without settings, placed the same way', async () => {
    const plain = await at(box())
    for (const blank of ['', '  \r\n\t\n ', BOM, `${BOM} \n`]) {
      const p = await readProject(box(blank), bed)
      expect(p.settings, JSON.stringify(blank)).toEqual({})
      expect(p.settingsNote, JSON.stringify(blank)).toBeUndefined()
      expect(await at(box(blank)), JSON.stringify(blank)).toEqual(plain)
    }
  })

  it('reads JSON after a byte order mark', async () => {
    for (const data of [`${BOM}${JSON_SETTINGS}`, new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(JSON_SETTINGS)])]) {
      const p = await readProject(box(data), bed)
      expect(p.settings['layer_height']).toBe('0.3')
      expect(p.colors).toEqual(['#FF0000'])
      expect(p.settingsNote).toBeUndefined()
    }
  })

  it('leaves key = value lines out with a note', async () => {
    const p = await readProject(box(INI), bed)
    expect(p.settings).toEqual({})
    expect(p.settingsNote).toBe(OLDER)
  })

  it('leaves a cut-off file, garbage and JSON that is not an object out with a note', async () => {
    for (const bad of [JSON_SETTINGS.slice(0, 30), 'nope', new Uint8Array([0, 1, 0xff, 0x20, 0x7b]), '[1, 2]', 'null', '"0.2"']) {
      const p = await readProject(box(bad), bed)
      expect(p.settings, String(bad)).toEqual({})
      expect(p.settingsNote, String(bad)).toBe(DAMAGED)
    }
  })
})

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

beforeEach(async () => {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], toast: null, unsavedPrompt: null }))
  await profileReady()
  startDirtyTracking()
  markClean()
})

describe('project settings that are not JSON, as the project opens', () => {
  it('opens with the note in the open toast', async () => {
    for (const [settings, note] of [[INI, OLDER], [JSON_SETTINGS.slice(0, 30), DAMAGED]] as const) {
      set({ plate: [], toast: null })
      await openModelBytes(host, 'community.3mf', buf(box(settings)), undefined, { fresh: true })
      expect(get().plate.map((p) => p.name), settings).toEqual(['box'])
      expect(get().toast?.text, settings).toContain(note)
    }
  })

  it('says nothing for an empty file', async () => {
    await openModelBytes(host, 'empty.3mf', buf(box('')), undefined, { fresh: true })
    expect(get().plate.map((p) => p.name)).toEqual(['box'])
    expect(get().toast?.text ?? '').not.toContain('print settings were left out')
  })
})
