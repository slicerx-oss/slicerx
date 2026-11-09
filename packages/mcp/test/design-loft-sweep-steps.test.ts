// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A loft or sweep from finished sketches records exactly the step Model's Loft and Sweep panels record for the same
// sketches: both go through the one builder in the design history (loftParams, sweepParams). The off-path check the
// app words for a person keeps its words here for a client.
import { loftParams, sweepParams, type Design, type DesignHost, type SketchItem, type StepParams } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { profileOffPath } from '../src/cad'
import { designToolset, NO_ENGINE_HOST } from '../src/toolset'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const up = (z: number) => ({ origin: [0, 0, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] })
const SKETCHES: SketchItem[] = [
  { kind: 'sketch', id: 'k1', name: 'Sketch 1', frame: up(0), loops: [{ points: [[-10, -10], [10, -10], [10, 10], [-10, 10]] }] },
  { kind: 'sketch', id: 'k2', name: 'Sketch 2', frame: up(20), loops: [{ type: 'circle', center: [0, 0], diameterMm: 12 }] },
  { kind: 'sketch', id: 'k3', name: 'Sketch 3', frame: { origin: [0, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ start: [0, 0], segments: [{ type: 'line', to: [0, 40] }] }] },
]

function host() {
  const d: Design = { id: 'd1', name: 'Part', history: { version: 1, base: [], steps: [] }, transform: I, parts: [], status: [], madeBy: {}, redo: [] }
  const recorded: StepParams[] = []
  const h: DesignHost = {
    ...NO_ENGINE_HOST,
    get: () => d,
    list: () => [d],
    add: async (_d, part, params) => {
      recorded.push(params)
      return { id: `s${recorded.length}`, part, transform: I, params }
    },
    sketch: (id) => SKETCHES.find((k) => k.id === id)!,
  }
  const tools = designToolset(h)
  const run = (name: string, input: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!
    return t.run(t.input.parse(input) as never, {} as never)
  }
  return { run, recorded }
}

const profileOf = (k: SketchItem) => ({ frame: k.frame, loops: k.loops })

describe('loft and sweep steps from finished sketches', () => {
  it('records the loft step the app records for the same sketches and options', async () => {
    const { run, recorded } = host()
    await run('geom.loft', { design: 'd1', sketches: ['k1', 'k2'], smooth: true, name: 'Neck' })
    await run('geom.loft', { design: 'd1', sketches: ['k2', 'k1'], operation: 'cut' })
    expect(recorded[0]).toEqual(loftParams({ profiles: [profileOf(SKETCHES[0]!), profileOf(SKETCHES[1]!)], smooth: true, closed: false, operation: 'new', name: 'Neck' }))
    expect(recorded[1]).toEqual(loftParams({ profiles: [profileOf(SKETCHES[1]!), profileOf(SKETCHES[0]!)], operation: 'cut' }))
    // the same key order, so a saved file reads the same from either
    expect(JSON.stringify(recorded[0])).toBe(JSON.stringify(loftParams({ profiles: [profileOf(SKETCHES[0]!), profileOf(SKETCHES[1]!)], smooth: true, operation: 'new', name: 'Neck' })))
  })

  it('records the sweep step the app records for the same profile and path sketches', async () => {
    const { run, recorded } = host()
    await run('geom.sweep', { design: 'd1', profile_sketch: 'k2', path_sketch: 'k3' })
    expect(JSON.stringify(recorded[0])).toBe(JSON.stringify(sweepParams({ profile: profileOf(SKETCHES[1]!), path: profileOf(SKETCHES[2]!), operation: 'new' })))
  })

  it('keeps its own words for a profile drawn away from the path start', () => {
    const words = profileOffPath(up(0), [{ type: 'circle', center: [0, 0], diameterMm: 4 }], [42, 0, 0])
    expect(words).toBe("profile: its loop sits 42 mm from where the path starts (42, 0, 0), and the profile is carried as it sits. Loop points are [u, v] from the profile frame's origin, so with the origin on the path's start a loop around it is centered at [0, 0].")
    expect(profileOffPath(up(0), [{ type: 'circle', center: [0, 0], diameterMm: 4 }], [5, 0, 0])).toBeNull()
  })
})
