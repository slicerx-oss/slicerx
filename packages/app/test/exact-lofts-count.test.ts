// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Lofts the native engine could not make exact, which a replay made as mesh lofts with no note (`exactLoftsQuiet`):
// the app counts them with each step's reason (quietLofts) and says so on the debug console only. Nothing reaches the
// step list or a toast.
import { afterEach, expect, it, vi } from 'vitest'
import { clearReplayCache, HISTORY_VERSION } from '@slicerx/cad-history'
import { setGeomProvider } from '../src/geom/client'
import { noteQuietLofts, quietLofts } from '../src/cad/history/exact-flag'
import { runReplay } from '../src/cad/history/ops'

afterEach(() => {
  vi.restoreAllMocks()
  setGeomProvider(null)
  clearReplayCache()
})

it("counts each quiet loft with its step's reason, on the debug console only", () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const before = quietLofts().count
  noteQuietLofts([{ step: 'q-a', why: 'First reason.' }])
  noteQuietLofts([{ step: 'q-b', why: 'Second reason.' }, { step: 'q-a', why: 'Third reason.' }])
  const now = quietLofts()
  expect(now.count).toBe(before + 3)
  // the latest reason for each step
  expect(now.steps['q-a']).toBe('Third reason.')
  expect(now.steps['q-b']).toBe('Second reason.')
  expect(debug).toHaveBeenCalledTimes(2)
  expect(warn).not.toHaveBeenCalled()
})

it('takes them from a replay, which the app asks for without the field: the provider sets it', async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  const asked: Record<string, unknown>[] = []
  setGeomProvider({
    runsJobs: true,
    async call<T>(op: string, request: unknown): Promise<T> {
      if (op !== 'history.replay') throw new Error(`unexpected ${op}`)
      asked.push(request as Record<string, unknown>)
      return { parts: [], status: [{ state: 'done' }], moved: {}, exactLoftsQuiet: [{ step: 'q-c', why: 'A reason.' }] } as T
    },
  })
  const before = quietLofts().count
  const r = await runReplay({ history: { version: HISTORY_VERSION, base: [], steps: [] } })
  expect(r.status).toEqual([{ state: 'done' }])
  expect('exactLofts' in asked[0]!).toBe(false)
  expect(quietLofts().count).toBe(before + 1)
  expect(quietLofts().steps['q-c']).toBe('A reason.')
})
