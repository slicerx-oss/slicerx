// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slice of a plate that is cleared, or canceled, while it runs never lands: the old plate's G-code can't show on the
// new plate, and Export and Print have nothing of it to send.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, SliceResult } from '@slicerx/contracts'
import { cancelSlice, exportGcode, sendToPrinter, slicePlate } from '../src/state/actions'
import { clearProject } from '../src/project/new'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const entry = { id: 'a', name: 'Tower.stl', handle, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } as never
const result = { id: 'old', engine: 'sx', layerCount: 10, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 600, filamentMm: [100], filamentG: [3], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [] } as unknown as SliceResult

/** A slicer whose slice finishes when the test says, whatever its signal says, as a worker that is mid-shard does. */
function slowSlicer() {
  let finish = (_: SliceResult) => undefined as void
  const saved: string[] = []
  const host = {
    kind: 'web',
    capabilities: { threads: 1 },
    files: { save: async (n: string) => void saved.push(n) },
    printers: { status: async () => ({ state: 'idle' }) },
    approvals: {},
    slicer: {
      slice: () => new Promise<SliceResult>((resolve) => (finish = resolve)),
      loadParts: async () => handle,
      getPreview: async () => new ArrayBuffer(0),
      exportGcode: async () => ({ fileName: 'old.gcode', bytes: 1, sha256: '', blob: new Blob(['G28']) }),
    },
  } as unknown as Host
  return { host, saved, finish: (r: SliceResult) => finish(r) }
}

beforeEach(() => set({ plate: [entry], slice: { status: 'idle' }, preview: null, printSheet: null, calibration: {}, layerMarks: {}, resume: null, toast: null }))

describe('a slice whose plate goes while it runs', () => {
  it('never lands on the cleared plate, and Export and Print have nothing to send', async () => {
    const { host, saved, finish } = slowSlicer()
    const slicing = slicePlate(host)
    await expect.poll(() => get().slice.status).toBe('running')
    clearProject()
    finish(result)
    await slicing
    expect(get().slice.status).toBe('idle')
    expect(get().preview).toBeNull()
    await exportGcode(host)
    expect(saved).toEqual([])
    await sendToPrinter(host, { id: 'p1', name: 'Bay 1', vendor: 'Test', model: 'T1', plugin: 'demo', nozzleCount: 1 } as never)
    expect(get().printSheet).toBeNull()
  })

  it('a slice canceled while it runs is dropped when the engine finishes anyway', async () => {
    const { host, finish } = slowSlicer()
    const slicing = slicePlate(host)
    await expect.poll(() => get().slice.status).toBe('running')
    cancelSlice({ quiet: true })
    finish(result)
    await slicing
    expect(get().slice.status).toBe('idle')
  })
})
