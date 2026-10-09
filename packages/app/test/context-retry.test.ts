// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D view asks again for a WebGL2 context before it opens in 2D, and the 2D fallback goes back to 3D once a
// context can be had.
import { describe, expect, it } from 'vitest'
import { RETRY_AT_MS, watchFor, withRetries } from '../src/viewport/context-retry'

/** A clock the code waits on: each wait is recorded and returns at once. */
function clock() {
  const waits: number[] = []
  return { waits, wait: async (ms: number) => void waits.push(ms) }
}

/** A context factory that fails `failures` times, then gives a context. */
function factory(failures: number) {
  let calls = 0
  return {
    calls: () => calls,
    make: () => {
      calls++
      if (calls <= failures) throw new Error('The 3D view needs WebGL2')
      return { context: calls }
    },
  }
}

describe('starting the 3D view', () => {
  it('asks again at about 300, 800 and 1500 ms', () => {
    expect(RETRY_AT_MS).toEqual([300, 800, 1500])
  })

  it('opens in 3D when a context comes on the third try, after waiting 300 then 500 ms', async () => {
    const c = clock()
    const f = factory(2)
    await expect(withRetries(f.make, RETRY_AT_MS, c.wait)).resolves.toEqual({ context: 3 })
    expect(f.calls()).toBe(3)
    expect(c.waits).toEqual([300, 500])
  })

  it('takes the first context without waiting', async () => {
    const c = clock()
    await expect(withRetries(factory(0).make, RETRY_AT_MS, c.wait)).resolves.toEqual({ context: 1 })
    expect(c.waits).toEqual([])
  })

  it('gives up with the last error after the try at 1500 ms', async () => {
    const c = clock()
    const f = factory(10)
    await expect(withRetries(f.make, RETRY_AT_MS, c.wait)).rejects.toThrow('needs WebGL2')
    expect(f.calls()).toBe(4)
    expect(c.waits).toEqual([300, 500, 700])
  })
})

describe('the 2D fallback', () => {
  it('goes back to 3D once a context can be had, checking less and less often', async () => {
    const c = clock()
    let tries = 0
    let ready = 0
    watchFor(() => ++tries === 4, () => ready++, { first: 5_000, max: 20_000 }, c.wait)
    await new Promise((r) => setTimeout(r, 0))
    expect(ready).toBe(1)
    expect(c.waits).toEqual([5_000, 10_000, 20_000, 20_000])
  })

  it('stops checking once the view is closed', async () => {
    let tries = 0
    let release: () => void = () => undefined
    const stop = watchFor(() => (tries++, true), () => undefined, { first: 5_000, max: 60_000 }, () => new Promise<void>((r) => (release = r)))
    stop()
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(tries).toBe(0)
  })
})
