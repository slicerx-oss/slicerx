// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slice that no longer matches the plate never passes for it: a stale slice can't be exported or sent, a slice
// canceled (or whose plate was cleared) while it finished never lands as done, and a refused slice leaves no toolpaths
// behind that look current.
import { beforeEach, describe, expect, it } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview, type Host, type SliceResult } from '@slicerx/contracts'
import { clearProject } from '../src/project/new'
import { cancelSlice, exportGcode, slicePlate } from '../src/state/actions'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const entry = { id: 'a', name: 'a', handle, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 10, 0, 1] } as never

/** One layer of one move, enough for the app to read. */
function rawPreview(): ArrayBuffer {
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + 2 * 4 + 8 + SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, 1, true)
  dv.setUint32(12, 1, true)
  dv.setUint32(20, 4, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  dv.setUint32(o + 4, 1, true)
  o += 8
  dv.setFloat32(o, 0.2, true)
  dv.setFloat32(o + 4, 1, true)
  o += 8
  dv.setFloat32(o + 8, 10, true)
  dv.setFloat32(o + 16, 0.2, true)
  dv.setUint16(o + 20, 400, true)
  dv.setUint16(o + 22, 200, true)
  return raw
}

/** A host whose engine and preview each wait for the test, and that records exports. */
function host(fail?: string) {
  const gates: { engine: (() => void) | null; preview: (() => void) | null } = { engine: null, preview: null }
  const saved: string[] = []
  const h = {
    kind: 'web',
    capabilities: { threads: 1 },
    files: { save: async (name: string) => void saved.push(name) },
    slicer: {
      loadParts: async () => handle,
      loadModel: async () => handle,
      slice: () =>
        new Promise((resolve, reject) => {
          gates.engine = () => (fail ? reject(new Error(fail)) : resolve({ id: 'r1', layerZ: Float32Array.from([0.2]), warnings: [] }))
        }),
      getPreview: () => new Promise((resolve) => (gates.preview = () => resolve(rawPreview()))),
      exportGcode: async () => ({ blob: new Blob(['G1']) }),
    },
  } as unknown as Host
  return { h, gates, saved }
}

const tick = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0))
}

const done = { status: 'done', result: { id: 'r0', fileName: 'a.gcode', layerCount: 1, stats: { filamentG: [1], timeS: 60, cost: 0, toolChanges: 0 } } as unknown as SliceResult, stale: false } as const

beforeEach(() => set({ plate: [entry], slice: { status: 'idle' }, preview: null, resume: null, calibration: {}, layerMarks: {}, toast: null }))

describe('stale slices', () => {
  it('will not export a slice from before the plate changed', async () => {
    const { h, saved } = host()
    set({ slice: { ...done, stale: true } })
    await exportGcode(h)
    expect(saved).toEqual([])
    expect(get().toast?.text).toMatch(/plate changed after this slice/)
  })

  it('a slice canceled while its preview loads does not land as done', async () => {
    const { h, gates } = host()
    const before = readPreview(rawPreview())
    set({ slice: done, preview: before })
    const run = slicePlate(h)
    await tick()
    gates.engine!()
    await tick()
    cancelSlice({ quiet: true })
    gates.preview!()
    await run
    // The last slice comes back, marked stale; nothing new lands.
    expect(get().slice).toMatchObject({ status: 'done', stale: true, result: { id: 'r0' } })
    expect(get().preview).toBe(before)
  })

  it('a plate cleared while it slices stays empty when the slice finishes', async () => {
    const { h, gates } = host()
    const run = slicePlate(h)
    await tick()
    clearProject()
    gates.engine!()
    await tick()
    gates.preview?.()
    await run
    expect(get().slice).toEqual({ status: 'idle' })
    expect(get().preview).toBeNull()
    expect(get().plate).toEqual([])
  })

  it('a refused slice clears the last toolpaths', async () => {
    const { h, gates } = host('Blocked: an object reaches off the bed')
    set({ slice: done, preview: readPreview(rawPreview()) })
    const run = slicePlate(h, { auto: true })
    await tick()
    gates.engine!()
    await run
    expect(get().slice).toMatchObject({ status: 'error' })
    expect(get().preview).toBeNull()
  })
})
