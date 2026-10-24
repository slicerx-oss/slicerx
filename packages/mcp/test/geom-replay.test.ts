// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A recorded geometry reply that no longer matches the request a test makes fails that test, naming the fixture and
// how to record it again, even when the code under test catches the engine's error and falls back. A real engine
// failure still falls back as before.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { EngineCall } from '@slicerx/cad-history'
import type { SettingValue } from '@slicerx/contracts'
import { ReplayMismatch, digest, replayEngine, type Recorded } from './geom-engine'
import { boxStl, connect, data, type Harness } from './helpers'

const FIXTURE = join(__dirname, 'fixtures', 'arrange-zones.json.gz')
/** A test in arrange-zones whose replies start with the footprint of a 30 x 30 x 10 mm box. */
const CORNER = 'slicerx_arrange on true outlines > keeps every copy out of an excluded corner'

async function call(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; summary: string }> {
  const r = await h.call(name, args)
  const d = data<{ ok?: boolean; summary: string }>(r)
  return { ok: d.ok ?? !r.isError, summary: d.summary }
}

/** A P1S project with `model` loaded and the settings `changes`. */
async function project(h: Harness, model: Buffer, changes: Record<string, SettingValue>): Promise<void> {
  writeFileSync(join(h.dir, 'part.stl'), model)
  await call(h, 'slicerx_project_open', { printer: 'Bambu Lab P1S', filament: 'Bambu PLA Basic' })
  await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
  await call(h, 'slicerx_project_set_overrides', { changes })
}

async function placed(h: Harness): Promise<number> {
  const shown = data<{ output: { plates: { placements: unknown[] }[] } }>(await h.call('slicerx_project_show', {}))
  return shown.output.plates[0]!.placements.length
}

describe('replayed geometry replies', () => {
  const one = (): ReturnType<typeof replayEngine> => replayEngine('fixtures/x.json.gz', { t: [{ op: 'nest.arrange', request: digest({ a: 1 }), reply: { ok: true } }] })

  it('answers a request that matches the recording with its reply', async () => {
    const r = one()
    r.start('t')
    expect(await r.engine('nest.arrange', { a: 1 })).toEqual({ ok: true })
    expect(r.stale).toEqual([])
  })

  it('names the fixture and how to record it again when a request differs', async () => {
    const r = one()
    r.start('t')
    await expect(r.engine('nest.arrange', { a: 2 })).rejects.toBeInstanceOf(ReplayMismatch)
    expect(r.stale).toHaveLength(1)
    expect(r.stale[0]).toContain('fixtures/x.json.gz is out of date for "t"')
    expect(r.stale[0]).toContain('the nest.arrange request of call 1 differs from the recorded one')
    expect(r.stale[0]).toContain('record it again with SX_GEOM_RECORD=1')
  })

  it('counts another op and a missing reply as out of date', async () => {
    const r = one()
    r.start('t')
    await expect(r.engine('nest.footprint', { a: 1 })).rejects.toBeInstanceOf(ReplayMismatch)
    await expect(r.engine('nest.arrange', { a: 1 })).rejects.toBeInstanceOf(ReplayMismatch)
    expect(r.stale[0]).toContain('call 1 is nest.footprint, recorded as nest.arrange')
    expect(r.stale[1]).toContain('no recorded reply for call 2 (nest.arrange)')
  })

  it('keeps the mismatch when arrange catches it and falls back to rows', async () => {
    const replies = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8')) as Record<string, Recorded[]>
    expect(replies[CORNER]?.length).toBeGreaterThan(0)
    const r = replayEngine(FIXTURE, replies)
    r.start(CORNER)
    const h = await connect({ geomEngine: r.engine })
    // One millimeter narrower than the recorded box, so the first footprint request differs.
    await project(h, boxStl(29, 30, 10), { skirt_loops: 0 })
    const res = await call(h, 'slicerx_arrange', { count: 20 })
    expect(res.ok, res.summary).toBe(true)
    expect(await placed(h)).toBe(20)
    expect(r.stale.length).toBeGreaterThan(0)
    expect(r.stale[0]).toContain(`${FIXTURE} is out of date for "${CORNER}"`)
    expect(r.stale[0]).toContain('SX_GEOM_RECORD=1')
  })

  it('still lays the plate out in rows when the engine itself fails', async () => {
    const failing: EngineCall = () => Promise.reject(new Error('sx-geom nest.footprint exited with code 1: no readable output'))
    const h = await connect({ geomEngine: failing })
    await project(h, boxStl(30, 30, 10), { skirt_loops: 0 })
    const res = await call(h, 'slicerx_arrange', { count: 20 })
    expect(res.ok, res.summary).toBe(true)
    expect(await placed(h)).toBe(20)
  })
})
