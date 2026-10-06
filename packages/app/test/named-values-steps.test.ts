// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Named values in history steps and project files: a step typed as `height + 2` follows `height`, a change to the
// value replays the steps that use it, a value a step uses cannot be removed, and the table and the bindings
// round-trip through the project file. Runs against the geometry engine (live wasm when built, recorded replies
// otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { History, HistoryMesh, StepParams } from '../src/cad/history/model'
import { bindNext, withStep } from '../src/cad/history/record'
import { refreshBound, removeValue, setValue } from '../src/cad/value-ops'
import { historyFiles } from '../src/export/history-file'
import { parseHistories } from '../src/export/history-read'
import { parseValues, valuesJson } from '../src/export/values-file'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('named-values-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const pull = (distanceMm: number): StepParams => ({ op: 'face.push', at: [100, 100, 5], normal: [0, 0, 1], distanceMm })
const topZ = (m: Pick<HistoryMesh, 'positions'>) => {
  let z = -Infinity
  for (let i = 2; i < m.positions.length; i += 3) z = Math.max(z, m.positions[i]!)
  return z
}

/** A 40 by 20 by 5 mm plate with its top pulled by `height + 2`, recorded the way a tool records it. */
function pulled(): History {
  const e = { parts: [boxMesh(40, 20, 5)] as MeshPart[], transform: T }
  bindNext('height + 2')
  return withStep(e, 0, pull(5))
}

beforeEach(() => {
  set({ namedValues: [{ name: 'height', expr: '3' }], plate: [], historyEdit: null })
})

describe('a step that follows a named value', () => {
  it('keeps the typed expression when it gives the step its number, and not otherwise', () => {
    expect(pulled().steps[0]!.bind).toBe('height + 2')
    const e = { parts: [boxMesh(40, 20, 5)] as MeshPart[], transform: T }
    bindNext('height')
    expect(withStep(e, 0, pull(5)).steps[0]!.bind).toBeUndefined()
    // A binding is used once: the next step without one stays plain.
    expect(withStep(e, 0, pull(3)).steps[0]!.bind).toBeUndefined()
  })

  it('replays when the value changes, and refuses to remove a value in use', async () => {
    const history = pulled()
    set({ plate: [{ id: 'o1', name: 'Plate', handle: handle('o1'), parts: [boxMesh(40, 20, 10)] as MeshPart[], colors: ['#888888'], transform: T, history }] })
    expect(await refreshBound(host)).toEqual({ replayed: [], broken: [] })
    setValue('height', '6')
    expect(await refreshBound(host)).toEqual({ replayed: ['o1'], broken: [] })
    const e = get().plate.find((p) => p.id === 'o1')!
    expect((e.history!.steps[0]!.params as { distanceMm: number }).distanceMm).toBe(8)
    expect(e.history!.steps[0]!.bind).toBe('height + 2')
    expect(topZ(e.parts[0]!)).toBeCloseTo(13)
    expect(() => removeValue('height')).toThrow(/used by 1 step/)
  })

  it('leaves a step alone when its value no longer resolves, and says so', async () => {
    set({ plate: [{ id: 'o1', name: 'Plate', handle: handle('o1'), parts: [boxMesh(40, 20, 10)] as MeshPart[], colors: ['#888888'], transform: T, history: pulled() }] })
    setValue('height', 'height * 2')
    const r = await refreshBound(host)
    expect(r.replayed).toEqual([])
    expect(r.broken[0]).toMatch(/height/)
    expect((get().plate[0]!.history!.steps[0]!.params as { distanceMm: number }).distanceMm).toBe(5)
  })
})

describe('the project file', () => {
  it('writes the table and reads back only what is valid', () => {
    const json = valuesJson([{ name: 'wall', expr: '2' }, { name: 'lip', expr: 'wall * 1.5' }])!
    const files = new Map([['Metadata/slicerx_values.json', new TextEncoder().encode(json)]])
    expect(parseValues(files)).toEqual([{ name: 'wall', expr: '2' }, { name: 'lip', expr: 'wall * 1.5' }])
    expect(valuesJson([])).toBeNull()
    const bad = JSON.stringify({ version: 1, values: [{ name: 'ok', expr: '1' }, { name: '2bad', expr: '1' }, { name: 'clearance', expr: '1' }, { name: 'long', expr: 'x'.repeat(500) }, { name: 'ok', expr: '2' }, 'junk'] })
    expect(parseValues(new Map([['Metadata/slicerx_values.json', new TextEncoder().encode(bad)]]))).toEqual([{ name: 'ok', expr: '1' }])
    expect(parseValues(new Map([['Metadata/slicerx_values.json', new TextEncoder().encode('{"version":2,"values":[]}')]]))).toEqual([])
    expect(parseValues(new Map())).toEqual([])
  })

  it('keeps a step binding through the history part', () => {
    const history = pulled()
    const files = new Map(historyFiles([{ id: 'o1', history }], new Map([['o1', 1]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    const back = parseHistories(files, new Set(['1'])).get('1')!
    expect(back.steps[0]!.bind).toBe('height + 2')
  })
})
