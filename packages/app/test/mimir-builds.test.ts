// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab's scripted mimir builds with the design tools on the plate: each script ends with its part on the plate,
// every step in the object's history like a person's edit. Runs against the geometry engine (live wasm when built,
// recorded replies otherwise).
import type { MeshHandle, MeshPart, PilotEvent } from '@slicerx/contracts'
import type { HistoryMesh } from '@slicerx/cad-history'
import { designToolset } from '@slicerx/mcp/toolset'
import type { ToolRowModel } from '@slicerx/pilot/ui'
import { beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { get, set } from '../src/state/store'
import { mimirTools, scriptedMimir } from '../src/workspaces/mimir/scripted'
import { SCRIPTS } from '../src/workspaces/mimir/scripts'
import { stepWords } from '../src/workspaces/mimir/step-words'
import { useGeomEngine } from './geom-engine'

useGeomEngine('mimir-builds-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

function volume(parts: readonly Pick<HistoryMesh, 'positions' | 'indices'>[]): number {
  let v = 0
  for (const m of parts) {
    const p = m.positions
    for (let k = 0; k + 2 < m.indices.length; k += 3) {
      const [a, b, c] = [3 * m.indices[k]!, 3 * m.indices[k + 1]!, 3 * m.indices[k + 2]!]
      v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6
    }
  }
  return Math.abs(v)
}

/** The shoelace area of a closed polygon. */
const area = (pts: readonly [number, number][]): number => Math.abs(pts.reduce((s, [x, y], i) => s + x * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * y, 0)) / 2

async function build(message: string): Promise<PilotEvent[]> {
  const p = scriptedMimir(SCRIPTS, mimirTools(designToolset(appDesignHost(loader))))
  const events: PilotEvent[] = []
  for await (const e of p.run('s', message)) {
    events.push(e)
    if (e.type === 'ask') void p.answer!(e.askId, 'same')
  }
  return events
}

const failed = (events: PilotEvent[]) => events.filter((e) => e.type === 'tool_result' && !e.ok)

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], historyEdit: null }))

describe('scripted mimir builds', () => {
  it('draws the thermostat backplate in one extrude, its three holes inside the outline', async () => {
    const events = await build('I need a wall mount for this thermostat')
    expect(failed(events)).toEqual([])
    const [e] = get().plate
    expect(e?.name).toBe('Thermostat backplate')
    expect(e?.history?.steps.map((s) => s.params.op)).toEqual(['shape.extrude'])
    const holes = Math.PI * (15 * 15 + 2 * 2.25 * 2.25) * 3
    expect(volume(e!.parts)).toBeCloseTo(150.4 * 110.4 * 3 - holes, -2)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })

  it('makes a box with 2 mm walls and a lid whose lip fits inside it', async () => {
    const events = await build('Can you make a box with a lid?')
    expect(failed(events)).toEqual([])
    const [e] = get().plate
    expect(e?.history?.steps).toHaveLength(4)
    expect(e?.parts.map((p) => p.name)).toEqual(['Box', 'Lid'])
    expect(volume([e!.parts[0]!])).toBeCloseTo(80 * 60 * 40 - 76 * 56 * 38, -1)
    expect(volume([e!.parts[1]!])).toBeCloseTo(80 * 60 * 2 + 75.6 * 55.6 * 3, -1)
  })

  it('extrudes the phone stand from its side profile, 70 mm wide', async () => {
    const events = await build('make me a phone stand')
    expect(failed(events)).toEqual([])
    const [e] = get().plate
    expect(e?.history?.steps).toHaveLength(1)
    const profile: [number, number][] = [[-40, 0], [40, 0], [40, 6], [0.4, 6], [27, 79.1], [21.4, 81.2], [-6, 6], [-34, 6], [-34, 16], [-40, 16]]
    expect(volume(e!.parts)).toBeCloseTo(area(profile) * 70, -1)
  })

  it('says what each extrude did in plain words', () => {
    const row = (summary: string): ToolRowModel => ({ callId: 'c', tool: 'geom.extrude', source: 'command', args: '', callSummary: undefined, state: 'ok', summary, display: [], progress: [], ms: 1, untrusted: false })
    expect(stepWords(row('Extruded: step 1, Extrude'))?.done).toBe('Extruded the sketch')
    expect(stepWords(row('Cut: step 2, Extrude'))?.done).toBe('Cut into the part')
    expect(stepWords(row('Joined: step 4, Extrude'))?.done).toBe('Added to the part')
  })

  it('stops with words, not a broken part, when the person names another thermostat', async () => {
    const p = scriptedMimir(SCRIPTS, mimirTools(designToolset(appDesignHost(loader))))
    for await (const e of p.run('s', 'wall mount for my thermostat')) if (e.type === 'ask') void p.answer!(e.askId, 'other')
    expect(get().plate).toHaveLength(0)
  })
})
