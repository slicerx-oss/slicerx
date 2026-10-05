// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { DEFAULT_POLICY, EASY_GOALS, type PrinterInfo } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, DEFAULT_CONFIG } from '@slicerx/pilot'
import { machineFor, phoneConfig, runCloudSlice, type PhoneModel, type SlicePhase } from '../cloud/slice-job'
import { boxStl, meshBounds } from '../cloud/stl'
import { createCloudStub } from '../cloud/stub'
import { createAlertTracker } from '../notify/watch'
import { createDemoClient, nextStep } from '../pilot/demo-client'
import type { Alert } from '../state/store'

const P1S: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu', nozzleCount: 1, filamentSystem: 'ams' }
const MK4S: PrinterInfo = { id: 'bay-3', name: 'Bay 3', vendor: 'Prusa Research', model: 'MK4S', plugin: 'prusalink', nozzleCount: 1 }

describe('stl', () => {
  it('reads the size of a binary STL', () => {
    const b = meshBounds(boxStl([20, 30, 40]))
    expect(b).toEqual({ triangles: 12, sizeMm: [20, 30, 40], measured: true })
  })

  it('reads an ASCII STL', () => {
    const text = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 5 2\nendloop\nendfacet\nendsolid t\n'
    const b = meshBounds(new TextEncoder().encode(text).buffer as ArrayBuffer)
    expect(b.sizeMm).toEqual([10, 5, 2])
    expect(b.triangles).toBe(1)
  })

  it('falls back to a default size for files it cannot read', () => {
    expect(meshBounds(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer).measured).toBe(false)
    // A header that claims more triangles than the file holds is not trusted.
    const lying = new ArrayBuffer(84)
    new DataView(lying).setUint32(80, 1_000_000, true)
    expect(meshBounds(lying).measured).toBe(false)
  })
})

describe('cloud slicing from the phone', () => {
  it('maps printers to their bed and flavor', () => {
    expect(machineFor(P1S)).toEqual({ bed: [256, 256, 256], flavor: 'bambu' })
    expect(machineFor(MK4S).bed).toEqual([250, 210, 220])
    const cfg = phoneConfig(EASY_GOALS.fine, MK4S, 'petg')
    expect(cfg.printable_height).toBe(220)
    expect(cfg.nozzle_temperature).toEqual([240])
    expect(cfg['filament_type']).toEqual(['PETG'])
  })

  it('reports every stage and returns G-code ready for upload', async () => {
    const model: PhoneModel = { id: 'm', name: 'Cube.stl', origin: 'sample', load: async () => boxStl([20, 20, 20]) }
    const phases: SlicePhase['kind'][] = []
    const out = await runCloudSlice(createCloudStub({ stageMs: 0, queueMs: 0 }), { model, printer: P1S, easy: EASY_GOALS.standard, material: 'pla' }, (p) => phases.push(p.kind))
    expect(phases[0]).toBe('uploading')
    expect(phases).toContain('slicing')
    expect(phases.at(-1)).toBe('downloading')
    expect(out.layerCount).toBe(100)
    expect(out.file.name).toBe('Cube.gcode')
    expect(out.file.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(out.warnings).toEqual([])
  })

  it('warns when the model is larger than the build volume', async () => {
    const model: PhoneModel = { id: 'm', name: 'Tall.stl', origin: 'file', load: async () => boxStl([40, 40, 300]) }
    const out = await runCloudSlice(createCloudStub({ stageMs: 0, queueMs: 0 }), { model, printer: MK4S, easy: EASY_GOALS.draft, material: 'pla' }, () => undefined)
    expect(out.warnings[0]).toMatch(/larger than the 250 x 210 x 220 mm build volume of Bay 3/)
  })

  it('stops on cancel', async () => {
    const c = new AbortController()
    const model: PhoneModel = { id: 'm', name: 'Cube.stl', origin: 'sample', load: async () => boxStl([20, 20, 20]) }
    const run = runCloudSlice(createCloudStub({ stageMs: 50, queueMs: 0 }), { model, printer: P1S, easy: EASY_GOALS.standard, material: 'pla' }, () => c.abort(), c.signal)
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('alerts', () => {
  const printers: PrinterInfo[] = [P1S, MK4S]
  const base = { nozzles: [], slots: [], cameraAvailable: false, updatedAt: '2026-09-30T00:00:00Z' }

  it('raises finished, failed and attention once each', () => {
    const got: Alert[] = []
    let t = 0
    const tr = createAlertTracker(printers, { onAlert: (a) => got.push(a), now: () => t })
    tr.onStatus({ ...base, printerId: 'bay-2', state: 'printing', jobName: 'Hex bin 2x2.gcode' })
    tr.onStatus({ ...base, printerId: 'bay-2', state: 'printing', jobName: 'Hex bin 2x2.gcode' })
    expect(got).toHaveLength(0)
    tr.onEvent({ type: 'job_finished', printerId: 'bay-2', jobName: 'Hex bin 2x2.gcode', ok: true })
    t += 1000
    tr.onStatus({ ...base, printerId: 'bay-2', state: 'finished', jobName: 'Hex bin 2x2.gcode' })
    tr.onStatus({ ...base, printerId: 'bay-3', state: 'paused', message: 'Filament runout' })
    tr.onEvent({ type: 'job_finished', printerId: 'bay-3', jobName: 'Clip.bgcode', ok: false })
    expect(got.map((a) => [a.kind, a.printerName])).toEqual([
      ['finished', 'Bay 2'],
      ['attention', 'Bay 3'],
      ['failed', 'Bay 3'],
    ])
    expect(got[1]?.detail).toBe('Filament runout')
  })

  it('clips long printer messages', () => {
    const got: Alert[] = []
    const tr = createAlertTracker(printers, { onAlert: (a) => got.push(a), now: () => 0 })
    tr.onStatus({ ...base, printerId: 'bay-3', state: 'error', message: 'x'.repeat(500) })
    expect(got[0]?.detail.length).toBeLessThanOrEqual(160)
  })
})

describe('mimir offline replies', () => {
  const ctx = 'Today is 2026-09-30.\nPermissions: slice allow, queue ask, start ask, profile ask.\n\nUser request:\n'

  it('asks for the printer control the person named', () => {
    const step = nextStep([{ role: 'system', content: 'sys' }, { role: 'user', content: `${ctx}Pause Bay 1` }])
    expect(step.call).toEqual({ name: 'printer.pause', args: { printerId: 'bay-1' } })
  })

  it('reads the context line as context, not as the request', () => {
    // "slice allow" in the permissions line must not route to the Slice tab.
    const step = nextStep([{ role: 'user', content: `${ctx}How are my printers doing?` }])
    expect(step.call?.name).toBe('printer.list')
  })

  it('stops at the approval card and sends nothing without Approve', async () => {
    const calls: string[] = []
    const broker = createApprovalBroker()
    const printers = {
      plugins: async () => [],
      list: async () => [P1S],
      status: async () => ({ printerId: 'bay-2', state: 'printing' as const, nozzles: [], slots: [], cameraAvailable: false, updatedAt: '' }),
      pause: async () => {
        calls.push('pause')
      },
    }
    const pilot = createPilot({
      host: { printers: printers as never, slicer: createCloudStub({ stageMs: 0, queueMs: 0 }), llm: { available: async () => false, stream: async function* () {} }, approvals: broker },
      config: DEFAULT_CONFIG,
      policy: DEFAULT_POLICY,
      client: createDemoClient({ delayMs: 0 }),
      approvalTimeoutMs: 50,
    })
    const types: string[] = []
    for await (const e of pilot.run('s1', 'Pause Bay 2')) types.push(e.type)
    expect(types).toContain('approval_request')
    expect(calls).toEqual([])
  })
})
