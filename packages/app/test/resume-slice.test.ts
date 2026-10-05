// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, SliceRequest } from '@slicerx/contracts'
import { slicePlate } from '../src/state/actions'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const entry = { id: 'a', name: 'a', handle, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } as never

/** A host whose slice records the request and then fails, which is enough to read the options. */
function capture(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async () => handle } } as unknown as Host
  return { host, requests }
}

beforeEach(() => set({ plate: [entry], resume: null, slice: { status: 'idle' }, calibration: {}, layerMarks: {} }))

describe('slice with a resume plan', () => {
  it('slices from the plan\'s layer and keeps the failed job\'s layer tops', async () => {
    const tops = [0.2, 0.4, 0.7, 1.0]
    set({ resume: { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: tops } })
    const { host, requests } = capture()
    await slicePlate(host)
    expect(requests[0]!.options).toMatchObject({ resumeFromLayer: 2, layerTopsMm: tops })
    expect(requests[0]!.options?.resumeZ).toBeUndefined()
  })

  it('declares the nozzle height when asked, and adds nothing without a plan', async () => {
    set({ resume: { plan: { resumeLayer: 3, printedHeightMm: 0.6 }, declareZ: true } })
    const a = capture()
    await slicePlate(a.host)
    expect(a.requests[0]!.options).toMatchObject({ resumeFromLayer: 3, resumeZ: { mode: 'declare', zMm: 0.6 } })
    set({ resume: null })
    const b = capture()
    await slicePlate(b.host)
    expect(b.requests[0]!.options).not.toHaveProperty('resumeFromLayer')
    expect(get().resume).toBeNull()
  })
})

describe('layer marks go to the engine by height', () => {
  it('slices once, with each mark at its height for the engine to place on its own layers', async () => {
    const marks = [{ id: 'm1', z: 2, kind: 'pause' as const }]
    set({ layerMarks: { 'plate-1': marks }, activePlate: 'plate-1' })
    const requests: SliceRequest[] = []
    const host = {
      kind: 'web',
      capabilities: { threads: 1 },
      slicer: {
        loadParts: async () => handle,
        slice: async (r: SliceRequest) => {
          requests.push(r)
          return { id: 'r1', layerZ: Float32Array.from([0.5, 1, 1.5, 2]), warnings: [] }
        },
        getPreview: async () => { throw new Error('stop') },
      },
    } as unknown as Host
    await slicePlate(host)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.options?.layerGcode).toEqual([{ zMm: 2, kind: 'pause' }])
  })
})
