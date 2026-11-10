// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the phone pairing secrets are named (features/phone/pair-slot.ts): a build may hand over a loader, so the
// sealing code is fetched when the printer bridge first connects and not before the first screen.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PairStorage } from '../src/features/phone/pair-slot'
import { pairStorage, pairStorageReady, setPairStorage } from '../src/features/phone/pair-slot'

const stores = (name: string): PairStorage => ({ identity: {} as PairStorage['identity'], pairings: {} as PairStorage['pairings'], name, kind: 'web' })

beforeEach(() => setPairStorage(null))

describe('pair storage', () => {
  it('hands back stores named directly, at once', async () => {
    const s = stores('direct')
    setPairStorage(s)
    expect(pairStorage()).toBe(s)
    expect(await pairStorageReady()).toBe(s)
  })

  it('has none until set, and none after it is cleared', async () => {
    expect(pairStorage()).toBeNull()
    expect(await pairStorageReady()).toBeNull()
  })

  it('runs a loader only when asked, once, and keeps what it made', async () => {
    const s = stores('loaded')
    const load = vi.fn(async () => s)
    setPairStorage(load)
    expect(load).not.toHaveBeenCalled()
    expect(pairStorage()).toBeNull()
    const [a, b] = await Promise.all([pairStorageReady(), pairStorageReady()])
    expect(a).toBe(s)
    expect(b).toBe(s)
    expect(await pairStorageReady()).toBe(s)
    expect(load).toHaveBeenCalledTimes(1)
    expect(pairStorage()).toBe(s)
  })

  it('asks the loader again after it failed', async () => {
    const s = stores('second try')
    const load = vi.fn<() => Promise<PairStorage>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(s)
    setPairStorage(load)
    await expect(pairStorageReady()).rejects.toThrow('offline')
    expect(await pairStorageReady()).toBe(s)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('takes a new loader in place of the last one', async () => {
    setPairStorage(async () => stores('old'))
    await pairStorageReady()
    setPairStorage(async () => stores('new'))
    expect((await pairStorageReady())?.name).toBe('new')
  })
})
