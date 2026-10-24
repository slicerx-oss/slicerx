// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A recorded geometry reply that no longer matches the request a test makes is kept as out of date, naming the
// fixture and how to record it again, so the test fails even when the code under test catches the error and falls
// back (useGeomEngine fails it after the test).
import { describe, expect, it } from 'vitest'
import { ReplayMismatch, replayGeom } from './geom-engine'

describe('replayed geometry replies', () => {
  const one = () => replayGeom('fixtures/x.json', { t: [{ op: 'nest.arrange', request: { a: 1 }, reply: { ok: true } }] })

  it('answers a request that matches the recording with its reply', async () => {
    const r = one()
    r.start('t')
    expect(await r.call('nest.arrange', { a: 1 })).toEqual({ ok: true })
    expect(r.stale).toEqual([])
  })

  it('names the fixture and how to record it again when a request differs', async () => {
    const r = one()
    r.start('t')
    await expect(r.call('nest.arrange', { a: 2 })).rejects.toBeInstanceOf(ReplayMismatch)
    expect(r.stale).toHaveLength(1)
    expect(r.stale[0]).toContain('fixtures/x.json is out of date for "t"')
    expect(r.stale[0]).toContain('the nest.arrange request of call 1 differs from the recorded one')
    expect(r.stale[0]).toContain('record it again with SX_GEOM_RECORD=1')
  })

  it('counts another op and a missing reply as out of date', async () => {
    const r = one()
    r.start('t')
    await expect(r.call('nest.footprint', { a: 1 })).rejects.toBeInstanceOf(ReplayMismatch)
    await expect(r.call('nest.arrange', { a: 1 })).rejects.toBeInstanceOf(ReplayMismatch)
    expect(r.stale[0]).toContain('call 1 is nest.footprint, recorded as nest.arrange')
    expect(r.stale[1]).toContain('no recorded reply for call 2 (nest.arrange)')
  })
})
