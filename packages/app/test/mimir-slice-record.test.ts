// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// app.slice in the mimir tab records a slice in the chat's print run only when the call made one. A call that slices
// nothing (a host that cannot slice) replies with the slice on screen but never records it again.
import type { CommandSpec, Host, MeshHandle, SliceResult } from '@slicerx/contracts'
import { createRunBook, runHandle, type CommandRun, type CommandToolContext } from '@slicerx/pilot'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { set, type PlateEntry } from '../src/state/store'
import { appPrintRun } from '../src/workspaces/mimir/print-run'
import { mimirCommands } from '../src/workspaces/mimir/session'

// what the next slicePlate call does: land a slice, or nothing (as on a host that cannot slice)
const fake = vi.hoisted(() => ({ next: null as null | (() => void) }))
vi.mock('../src/state/actions', async (orig) => ({
  ...(await orig<typeof import('../src/state/actions')>()),
  slicePlate: async () => {
    fake.next?.()
  },
}))

const handle: MeshHandle = { id: 'm1', hash: 'm1', name: 'Bracket', triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [] }
const bracket: PlateEntry = { id: 'a', name: 'Bracket', handle, parts: [{ ...boxMesh(40, 20, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }

const result = (id: string, timeS: number): SliceResult =>
  ({ id, engine: 'native', layerCount: 50, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS, filamentMm: [1000], filamentG: [12], cost: 0.3, toolChanges: 0 }, stageMicros: {}, wallMs: 5, warnings: [] }) as unknown as SliceResult

const lands = (id: string, timeS: number) => () => set((st) => ({ slicesDone: st.slicesDone + 1, slice: { status: 'done', result: result(id, timeS), stale: false } }))

describe('app.slice records its slice once', () => {
  beforeEach(() => {
    fake.next = null
    set({ plate: [bracket], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', overrides: {}, objectSettings: {}, slice: { status: 'idle' } })
  })

  it('records a slice it made, and nothing for a call that sliced nothing', async () => {
    const command: CommandSpec = { id: 'slice', title: 'Slice the plate', section: 'slice', tool: { permission: 'slice' }, run: () => undefined }
    const [mine] = mimirCommands({ kind: 'web', capabilities: { threads: 1 } } as unknown as Host, [command])
    const runs = runHandle(createRunBook(appPrintRun(), () => Date.parse('2026-10-20T00:00:00.000Z')), 'tab')
    const recorded: string[] = []
    const narrow: CommandRun = {
      update: (p) => {
        recorded.push(p.slice?.sliceId ?? '')
        return runs.update(p)
      },
      fingerprint: (n) => runs.fingerprint(n),
    }
    const call = () => Promise.resolve((mine!.run as (input: unknown, cx: CommandToolContext) => unknown)({}, { run: narrow }))

    fake.next = lands('s1', 1800)
    expect(await call()).toMatchObject({ status: 'done', sliceId: 's1', timeS: 1800 })
    expect(recorded).toEqual(['s1'])
    expect(runs.get().slice).toMatchObject({ sliceId: 's1', plate: 1, fingerprint: appPrintRun().fingerprint(1), stale: false })

    // the host cannot slice this time: the reply names the slice on screen, which is not recorded a second time
    fake.next = null
    expect(await call()).toMatchObject({ status: 'done', sliceId: 's1' })
    expect(recorded).toEqual(['s1'])

    // a new slice is recorded, once
    fake.next = lands('s2', 600)
    expect(await call()).toMatchObject({ status: 'done', sliceId: 's2', timeS: 600 })
    expect(recorded).toEqual(['s1', 's2'])
    expect(runs.get().slice).toMatchObject({ sliceId: 's2', timeS: 600, stale: false })
  })

  it('records nothing for a slice the engine refused, and drops the plate\'s kept slice', async () => {
    const command: CommandSpec = { id: 'slice', title: 'Slice the plate', section: 'slice', tool: { permission: 'slice' }, run: () => undefined }
    const [mine] = mimirCommands({ kind: 'web', capabilities: { threads: 1 } } as unknown as Host, [command])
    const runs = runHandle(createRunBook(appPrintRun(), () => Date.parse('2026-10-20T00:00:00.000Z')), 'tab')
    const recorded: string[] = []
    const narrow: CommandRun = { update: (p) => { recorded.push(p.slice?.sliceId ?? ''); return runs.update(p) }, fingerprint: (n) => runs.fingerprint(n) }
    const sliced: number[] = []
    const refused: number[] = []
    fake.next = () => set({ slice: { status: 'error', message: 'toolpaths lie outside the printable area from layer 1 (X-7.5 Y-7.5, Peg)' } })
    const out = await Promise.resolve((mine!.run as (input: unknown, cx: CommandToolContext) => unknown)({}, { run: narrow, sliced: (n) => void sliced.push(n), refused: (n) => void refused.push(n) }))
    expect(out).toEqual({ status: 'error', message: 'toolpaths lie outside the printable area from layer 1 (X-7.5 Y-7.5, Peg)' })
    expect(recorded).toEqual([])
    expect(runs.get().slice).toBeNull()
    expect(sliced).toEqual([])
    expect(refused).toEqual([1])
  })
})
