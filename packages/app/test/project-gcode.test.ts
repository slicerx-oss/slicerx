// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Lab A1 project's own printer G-code, from a project made from SlicerX's A1 profile: stock text slices with
// no question, changed text waits for the person, who picks the project's G-code or the profile's.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, SettingValue, SliceRequest } from '@slicerx/contracts'
import { resolveConfig } from '../src/adapters/config'
import { readProject } from '../src/export/import3mf'
import { zip } from '../src/export/zip'
import { slicePlate, trustOptions } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { answerProjectGcode, reviewOpenedGcode } from '../src/state/project-gcode'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const entry = { id: 'a', name: 'a', handle, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } as never

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`

let stockStart = ''
let stockEnd = ''

/** A Bambu Studio style A1 project made from SlicerX's own A1 profile, with `start` as its start G-code. */
async function openA1Project(start: string): Promise<number> {
  const bytes = zip([
    { name: '3D/3dmodel.model', data: MODEL },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ printer_settings_id: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', machine_start_gcode: start, machine_end_gcode: stockEnd }) },
  ])
  const project = await readProject(bytes, { widthMm: 256, depthMm: 256 })
  return reviewOpenedGcode('a1.3mf', project.settings)
}

/** A host whose slice records the request and then stops. */
function capture(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async () => handle } } as unknown as Host
  return { host, requests }
}

const startOf = (r: SliceRequest): unknown => (r.config as Record<string, SettingValue>)['machine_start_gcode']
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
}

beforeEach(async () => {
  set({ printerModel: { id: 'bambu-a1', vendor: 'Bambu Lab', model: 'A1' }, plate: [entry], overrides: {}, vouchedGcode: {}, projectGcode: null, resume: null, calibration: {}, layerMarks: {}, slice: { status: 'idle' } })
  await profileReady()
  const cfg = resolveConfig(get().easy, {}) as Record<string, SettingValue>
  stockStart = String(cfg['machine_start_gcode'])
  stockEnd = String(cfg['machine_end_gcode'])
})

describe("a project's own printer G-code", () => {
  it('slices the stock A1 start G-code, M211, M500 and M18 included, with no question', async () => {
    expect(stockStart).toMatch(/^M211 X0 Y0 Z0/m)
    expect(stockStart).toMatch(/^\s*M500/m)
    expect(stockStart).toMatch(/^M18/m)
    expect(await openA1Project(stockStart.replace(/\n/g, '\r\n'))).toBe(0)
    expect(get().projectGcode).toBeNull()
    const { host, requests } = capture()
    await slicePlate(host)
    expect(requests).toHaveLength(1)
    expect(startOf(requests[0]!)).toBe(stockStart)
    expect(requests[0]!.options?.trustedGcode).toBe(true)
  })

  const edited = (): string => stockStart.replace('M1002 gcode_claim_action : 2', 'M1002 gcode_claim_action : 2\nM500 ; keep my offsets')

  it('holds changed G-code for the person, with the added M500 flagged', async () => {
    expect(await openA1Project(edited())).toBe(1)
    const c = get().projectGcode!.changes[0]!
    expect(c.key).toBe('machine_start_gcode')
    expect(c.flags.map((f) => [f.line, f.code, f.severity])).toEqual([[10, 'eeprom_write', 'warning']])
    expect(c.approvable).toBe(true)
    // A background slice does not ask: it uses the profile's G-code until the person chooses.
    const { host, requests } = capture()
    await slicePlate(host, { auto: true })
    expect(startOf(requests[0]!)).toBe(stockStart)
    expect(get().projectGcode?.asking).toBe(false)
  })

  it("uses the project's G-code when the person chooses it", async () => {
    await openA1Project(edited())
    const { host, requests } = capture()
    const sliced = slicePlate(host)
    await until(() => get().projectGcode?.asking === true)
    expect(requests).toHaveLength(0)
    answerProjectGcode('project')
    await sliced
    expect(startOf(requests[0]!)).toBe(edited())
    expect(requests[0]!.options?.trustedGcode).toBe(true)
    expect(get().projectGcode).toBeNull()
    // An edit after the choice is the person's own text again, which gets the strict checks.
    expect(trustOptions({ ...get(), overrides: { ...get().overrides, machine_start_gcode: `${edited()}\nM84` } }).trustedGcode).toBeUndefined()
  })

  it("uses the printer profile's G-code when the person declines", async () => {
    await openA1Project(edited())
    const { host, requests } = capture()
    const sliced = slicePlate(host)
    await until(() => get().projectGcode?.asking === true)
    answerProjectGcode('profile')
    await sliced
    expect(startOf(requests[0]!)).toBe(stockStart)
    expect(requests[0]!.options?.trustedGcode).toBe(true)
    expect(get().overrides).not.toHaveProperty('machine_start_gcode')
  })

  it('does not slice when the person closes the dialog, and asks again next time', async () => {
    await openA1Project(edited())
    const { host, requests } = capture()
    const sliced = slicePlate(host)
    await until(() => get().projectGcode?.asking === true)
    answerProjectGcode(null)
    await sliced
    expect(requests).toHaveLength(0)
    expect(get().projectGcode?.asking).toBe(false)
  })

  it('offers only the profile when a line can never run', async () => {
    await openA1Project(`${stockStart}\nSAVE_CONFIG`)
    expect(get().projectGcode!.changes[0]!.approvable).toBe(false)
    expect(() => answerProjectGcode('project')).toThrow(/cannot be approved/)
  })
})
