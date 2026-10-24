// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A file handed over at launch has its geometry worker started while the app is still starting: a project's reader
// takes a worker started ahead of it with the core engine loading, a mesh file's import the shared worker warmed the
// same way. A spare nobody takes ends on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endIdleGeomWorker, IDLE_MS, setGeomProvider, soloCall, startGeomFor, startSpareGeomWorker } from '../src/geom/client'
import { engineModules } from '../src/geom/modules'

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: { id: number; op: string }[] = []
  terminated = false
  postMessage(m: { id: number; op: string }) {
    this.posted.push(m)
  }
  reply(id: number, result: unknown) {
    this.onmessage?.({ data: { id, result } } as MessageEvent)
  }
  terminate() {
    this.terminated = true
  }
}

let made: FakeWorker[] = []

beforeEach(() => {
  made = []
  vi.stubGlobal('Worker', function () {
    const w = new FakeWorker()
    made.push(w)
    return w
  })
  setGeomProvider(null)
})

afterEach(() => {
  endIdleGeomWorker()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a geometry worker started ahead of its call', () => {
  it('loads the core at once, and the next call of its own runs in it', async () => {
    startSpareGeomWorker()
    expect(made).toHaveLength(1)
    expect(made[0]!.posted).toEqual([{ id: 0, op: 'engine.core', request: null }])
    const { answer } = soloCall<string>('format.read3mf', { data: { bytes: new Uint8Array(4) } })
    // no second worker: the call went to the one already starting
    expect(made).toHaveLength(1)
    expect(made[0]!.posted[1]).toMatchObject({ id: 1, op: 'format.read3mf' })
    // the core's start-up answer is not the call's
    let done = false
    void answer.then(() => (done = true))
    made[0]!.reply(0, true)
    await Promise.resolve()
    expect(done).toBe(false)
    made[0]!.reply(1, 'project')
    await expect(answer).resolves.toBe('project')
    expect(made[0]!.terminated).toBe(true)
    // taken once: the call after starts its own worker as before
    soloCall('format.read3mf', {})
    expect(made).toHaveLength(2)
  })

  it('ends unused after the idle time', () => {
    vi.useFakeTimers()
    startSpareGeomWorker()
    startSpareGeomWorker()
    expect(made).toHaveLength(1)
    vi.advanceTimersByTime(IDLE_MS - 1)
    expect(made[0]!.terminated).toBe(false)
    vi.advanceTimersByTime(1)
    expect(made[0]!.terminated).toBe(true)
    soloCall('format.read3mf', {})
    expect(made).toHaveLength(2)
  })

  it('starts nothing when a host has its own engine', () => {
    setGeomProvider({ call: async () => null as never })
    startSpareGeomWorker()
    startGeomFor('three plates.3mf')
    expect(made).toHaveLength(0)
  })
})

describe('the engine for a file about to open', () => {
  it('a project gets a spare worker, a mesh file the shared worker, anything else none', async () => {
    vi.useFakeTimers()
    startGeomFor('x-mark three plates.3mf')
    expect(made).toHaveLength(1)
    expect(made[0]!.posted.map((m) => m.op)).toEqual(['engine.core'])
    // the spare ends unused, so the next file starts the shared worker
    vi.advanceTimersByTime(IDLE_MS)
    startGeomFor('bracket.STL')
    expect(made).toHaveLength(2)
    expect(made[1]!.posted.map((m) => m.op)).toEqual(['engine.core'])
    startGeomFor('plate.gcode')
    startGeomFor('locked.sxlock')
    expect(made).toHaveLength(2)
  })
})

describe('the engine modules', () => {
  it('loads only the core when asked to start', async () => {
    const log: string[] = []
    const load = (name: string) => async () => {
      log.push(name)
      return { operations: new Set<string>(), call: () => null }
    }
    const m = engineModules(load('core'), load('full'))
    expect(await m.core()).toBe(true)
    expect(await m.core()).toBe(true)
    expect(log).toEqual(['core'])
  })
})
