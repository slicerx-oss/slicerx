// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project whose G-code script check fails, returns nothing or never answers still opens with its own settings.
// Its scripts stay unreviewed, so they wait for the person at the next slice like any script the engine did not vouch for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshHandle, ScriptReview, ScriptReviewInput } from '@slicerx/contracts'
import { zip } from '../src/export/zip'
import { startProjectPrinterSync } from '../src/project/project-printer'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { openModelBytes } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const hostWith = (reviewScripts: (inputs: ScriptReviewInput[]) => Promise<ScriptReview[]>): Host =>
  ({ kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name), reviewScripts } }) as unknown as Host

const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const CUBE = '<object id="1" name="Cube" type="model"><mesh><vertices>' +
  [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]].map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('') +
  '</vertices><triangles>' +
  [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]].map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('') +
  '</triangles></mesh></object>'

/** A Bambu Studio style P1S project with a brim type of its own and a start G-code of its own. */
function project(): ArrayBuffer {
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${CUBE}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>`
  const cfg = '<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="Cube"/></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance></plate></config>'
  const settings = {
    printer_settings_id: 'Bambu Lab P1S 0.4 nozzle', printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], printable_area: ['0x0', '256x0', '256x256', '0x256'],
    layer_height: '0.2', filament_colour: ['#000000'], brim_type: 'brim_ears', machine_start_gcode: 'G28\nM400 U1 ; project start',
  }
  return buf(zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
}

const FAILURES: [string, () => Promise<ScriptReview[]>][] = [
  ['returns nothing', async () => null as unknown as ScriptReview[]],
  ['throws', async () => { throw new Error('Command review_scripts not found') }],
  ['never answers', () => new Promise<ScriptReview[]>(() => undefined)],
]

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', overrides: {}, projectSettings: null, projectPrinter: null, projectScriptReviews: null, projectGcode: null, toast: null }))
  await profileReady()
  startProjectPrinterSync()
  startDirtyTracking()
  markClean()
})
afterEach(() => vi.useRealTimers())

describe('opening a project when its G-code check fails', () => {
  it.each(FAILURES)('still applies the project settings when the check %s', async (_name, review) => {
    let done = false
    const opening = openModelBytes(hostWith(review), 'figure.3mf', project(), undefined, { fresh: true }).then(() => { done = true })
    // The clock runs ahead while the open loads its modules, so a check that never answers is given up on.
    for (let i = 0; i < 400 && !done; i++) {
      await vi.advanceTimersByTimeAsync(1_000)
      await new Promise((resolve) => setImmediate(resolve))
    }
    await opening
    expect(get().plate).toHaveLength(1)
    expect(get().overrides['brim_type']).toBe('brim_ears')
    expect(get().toast?.tone).not.toBe('error')
    const records = get().projectScriptReviews?.records ?? []
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.review.decision === 'review')).toBe(true)
  })
})
