// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A join or cut the engine reports as leaving the part open still lands, with a note on its step, so the timeline and
// the step's result say the part needs a look before it is printed; a closed result has no note.
import { beforeEach, expect, it } from 'vitest'
import { IDENTITY, NOT_CLOSED, clearReplayCache, replayHistory, type History, type HistoryMesh } from '@slicerx/cad-history'

const base = (): HistoryMesh => ({ name: 'Stem', slot: 1, positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], indices: [0, 1, 2, 0, 2, 3] })
const sweep = (): History => ({
  version: 1,
  base: [base()],
  steps: [{ id: 'hook-1', part: 0, transform: [...IDENTITY], params: { op: 'sketch.sweep', profile: { frame: { origin: [0, 0, 0], normal: [0, 0, 1] }, loops: [] }, path: { points: [[0, 0, 0], [0, 0, 10]] }, operation: 'join' } as never }],
})
const engine = (watertight: boolean) => async (_op: string, req: unknown) => ({ mesh: (req as { target: { mesh: unknown } }).target.mesh, report: { touches: true, watertight, shells: 1, volumeChangeMm3: 1 } })

beforeEach(() => clearReplayCache())

it('notes a join that leaves the part open, and nothing on a closed one', async () => {
  const open = await replayHistory(engine(false), { history: sweep() })
  expect(open.status[0]?.state).toBe('done')
  expect(open.status[0]?.note).toMatch(/not closed/)
  expect(open.status[0]?.note).toBe(NOT_CLOSED)
  clearReplayCache()
  const closed = await replayHistory(engine(true), { history: sweep() })
  expect(closed.status[0]).toEqual({ state: 'done' })
})
