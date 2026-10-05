// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, SliceRequest, SliceResult } from '@slicerx/contracts'
import { exportGcode, sendToPrinter, slicePlate } from '../src/state/actions'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const entry = { id: 'a', name: 'Desk hook.stl', handle, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } as never
const plates = [
  { id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } },
  { id: 'p2', name: 'Lids', objects: [], settings: { sequence: 'by-layer' } },
] as never

const result = (fileName?: string) => ({ id: 'r1', engine: 'sx', layerCount: 10, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 600, filamentMm: [100], filamentG: [3], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [], ...(fileName ? { fileName } : {}) }) as SliceResult

beforeEach(() => set({ plate: [entry], plates, activePlate: 'p2', slice: { status: 'idle' }, printSheet: null, calibration: {}, layerMarks: {}, resume: null }))

describe('file names from the engine', () => {
  it('tells the engine the plate name, number and the project name', async () => {
    const requests: SliceRequest[] = []
    const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async () => handle } } as unknown as Host
    await slicePlate(host)
    expect(requests[0]!.options).toMatchObject({ plateName: 'Lids', plateNumber: 2, modelName: 'Desk_hook' })
  })

  const exporting = (name: string | undefined) => {
    const saved: string[] = []
    const host = {
      kind: 'web',
      files: { save: async (n: string) => void saved.push(n) },
      slicer: { exportGcode: async () => ({ fileName: 'slice-1.gcode', bytes: 1, sha256: '', blob: new Blob(['G28']) }) },
    } as unknown as Host
    set({ slice: { status: 'done', result: result(name), stale: false } })
    return { host, saved }
  }

  it('saves G-code under the engine\'s name', async () => {
    const { host, saved } = exporting('Desk_hook_PLA_1h3m.gcode')
    await exportGcode(host)
    expect(saved).toEqual(['Desk_hook_PLA_1h3m.gcode'])
  })

  it('keeps today\'s name when the engine gave none', async () => {
    const { host, saved } = exporting(undefined)
    await exportGcode(host)
    expect(saved).toEqual(['desk-hook-stl_plate-1.gcode'])
  })

  it('opens the Print sheet with the engine\'s name, or today\'s without one', async () => {
    const printer = { id: 'p1', name: 'Bay 1', vendor: 'Test', model: 'T1', plugin: 'demo', nozzleCount: 1 } as never
    for (const [name, want] of [['Lids_PLA_1h.gcode', 'Lids_PLA_1h.gcode'], [undefined, 'desk-hook-stl_plate-1.gcode']] as const) {
      set({ slice: { status: 'done', result: result(name), stale: false }, printSheet: null })
      const host = {
        kind: 'web',
        printers: { status: async () => ({ state: 'idle' }) },
        approvals: {},
        slicer: { exportGcode: async () => ({ fileName: 'x.gcode', bytes: 1, sha256: '', blob: new Blob(['G28']) }) },
      } as unknown as Host
      const done = sendToPrinter(host, printer)
      await vi.waitFor(() => expect(get().printSheet).not.toBeNull())
      expect(get().printSheet!.name).toBe(want)
      get().printSheet!.resolve(null)
      await done
    }
  })
})
