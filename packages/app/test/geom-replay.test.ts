// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A recorded geometry reply that no longer matches the request a test makes is kept as out of date, naming the
// fixture and how to record it again, so the test fails even when the code under test catches the error and falls
// back (useGeomEngine fails it after the test).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { zip, zipCompressed } from '../src/export/zip'
import { ReplayMismatch, replayGeom, unzipped, withIds, writeRecording } from './geom-engine'

describe('replayed geometry replies', () => {
  const one = () => replayGeom('fixtures/x.json', { t: [{ op: 'nest.arrange', request: { a: 1 }, reply: { ok: true } }] })

  it('answers a request that matches the recording with its reply', async () => {
    const r = one()
    r.start('t')
    expect(await r.call('nest.arrange', { a: 1 })).toEqual({ ok: true })
    expect(r.stale).toEqual([])
  })

  // Two tests of a file, each with its own recorded list. A call that is in the other test's list is no answer for this one.
  const two = () => replayGeom('fixtures/x.json', {
    a: [{ op: 'nest.arrange', request: { a: 1 }, reply: { from: 'a' } }],
    b: [{ op: 'nest.footprint', request: { b: 1 }, reply: { from: 'b' } }, { op: 'nest.arrange', request: { b: 2 }, reply: { from: 'b2' } }],
  })

  it('replays only the running test\'s own list: a wrong extra call that another test recorded still fails', async () => {
    const r = two()
    r.start('b')
    await expect(r.call('nest.arrange', { a: 1 })).rejects.toBeInstanceOf(ReplayMismatch)
    expect(r.stale).toHaveLength(1)
    expect(r.stale[0]).toContain('call 1 is nest.arrange, recorded as nest.footprint')
  })

  it('fails a call that skips ahead in the test\'s own list, and one that repeats a call', async () => {
    const r = two()
    r.start('b')
    // The second recorded call, made first.
    await expect(r.call('nest.arrange', { b: 2 })).rejects.toBeInstanceOf(ReplayMismatch)
    expect(r.stale[0]).toContain('call 1 is nest.arrange, recorded as nest.footprint')
    // After the miss the first recorded call is made, but the list has moved on: it does not hold it at call 2.
    await expect(r.call('nest.footprint', { b: 1 })).rejects.toBeInstanceOf(ReplayMismatch)
    expect(r.stale).toHaveLength(2)
    const again = two()
    again.start('b')
    expect(await again.call('nest.footprint', { b: 1 })).toEqual({ from: 'b' })
    await expect(again.call('nest.footprint', { b: 1 })).rejects.toBeInstanceOf(ReplayMismatch)
  })

  it('answers each test from its own list in order, whatever the order the tests run in', async () => {
    const r = two()
    r.start('b')
    expect(await r.call('nest.footprint', { b: 1 })).toEqual({ from: 'b' })
    expect(await r.call('nest.arrange', { b: 2 })).toEqual({ from: 'b2' })
    r.start('a')
    expect(await r.call('nest.arrange', { a: 1 })).toEqual({ from: 'a' })
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

// A project file goes to format.read3mf as bytes. Node's deflate packs the same entries into different bytes on macOS
// and on Linux x64, so a recorded archive matches a live one on the files it holds, not on its bytes.
describe('archives in a request', () => {
  const files = (plans: string) => [
    { name: '3D/3dmodel.model', data: `<model>${'<vertex x="1" y="2" z="3"/>'.repeat(40)}</model>` },
    { name: 'Metadata/slicerx_plans.json', data: plans },
  ]
  /** The request as a recording keeps it: bytes go through JSON as an object of index keys. */
  const request = (bytes: Uint8Array) => JSON.parse(JSON.stringify({ data: { bytes } })) as unknown
  const replay = (bytes: Uint8Array) => replayGeom('fixtures/x.json', { t: [{ op: 'format.read3mf', request: request(bytes), reply: { ok: true } }] })

  it('matches the same files packed into other bytes: stored against deflated, and another version-made-by', async () => {
    const plans = JSON.stringify({ plans: [{ id: 'p1' }] })
    const deflated = await zipCompressed(files(plans))
    const stored = zip(files(plans))
    expect(stored).not.toEqual(deflated)
    const madeBy = deflated.slice()
    // the central directory's version-made-by of the first entry
    const view = new DataView(madeBy.buffer)
    const central = view.getUint32(madeBy.length - 22 + 16, true)
    view.setUint16(central + 4, 0x031e, true)
    for (const live of [stored, madeBy]) {
      const r = replay(deflated)
      r.start('t')
      expect(await r.call('format.read3mf', { data: { bytes: live } })).toEqual({ ok: true })
      expect(r.stale).toEqual([])
    }
  })

  it('fails an archive whose files differ, and one with a file missing', async () => {
    const recorded = await zipCompressed(files(JSON.stringify({ plans: [{ hole: 3 }] })))
    for (const live of [await zipCompressed(files(JSON.stringify({ plans: [{ hole: 4 }] }))), await zipCompressed(files('x').slice(0, 1))]) {
      const r = replay(recorded)
      r.start('t')
      await expect(r.call('format.read3mf', { data: { bytes: live } })).rejects.toBeInstanceOf(ReplayMismatch)
      expect(r.stale[0]).toContain('the format.read3mf request of call 1 differs from the recorded one')
    }
  })

  it('reads JSON files as data, so their generated ids pair like any others, and leaves other bytes alone', async () => {
    const r = replayGeom('fixtures/x.json', {
      t: [{ op: 'format.read3mf', request: request(await zipCompressed(files(JSON.stringify({ step: 's1782000000000a85' })))), reply: { step: 's1782000000000a85' } }],
    })
    r.start('t')
    expect(await r.call('format.read3mf', { data: { bytes: zip(files(JSON.stringify({ step: 's1782000000000a86' }))) } })).toEqual({ step: 's1782000000000a86' })
    const plain = request(new Uint8Array([1, 2, 3])) as { data: { bytes: unknown } }
    expect((unzipped(plain) as typeof plain).data.bytes).toBe(plain.data.bytes)
  })
})

describe('swapping recorded ids for the live ones', () => {
  it('swaps chained ids once: recorded 85 and 86 become live 86 and 87, not 87 twice', () => {
    const ids = new Map([['d1785', 'd1786'], ['d1786', 'd1787']])
    expect(withIds({ from: 'd1785', to: 'd1786' }, ids)).toEqual({ from: 'd1786', to: 'd1787' })
    expect(withIds(['d1786', 'd1785', 'd1786'], ids)).toEqual(['d1787', 'd1786', 'd1787'])
  })

  it('swaps a longer id that starts with another one as its own, and leaves ids inside longer text alone', () => {
    const ids = new Map([['d17', 'x1'], ['d1785', 'x2']])
    expect(withIds(['d17', 'd1785', 'd178', 'my d17 text', 'd1785b'], ids)).toEqual(['x1', 'x2', 'd178', 'my d17 text', 'd1785b'])
  })

  it('takes an id with regex characters literally', () => {
    const ids = new Map([['a.b+c(1)', 'z'], ['a.b', 'y']])
    expect(withIds(['a.b+c(1)', 'a.b', 'axb', 'a.b+c(1', 'a"b'], ids)).toEqual(['z', 'y', 'axb', 'a.b+c(1', 'a"b'])
  })

  it('swaps an id used as an object key, and leaves the other values and a map with no ids alone', () => {
    const ids = new Map([['d1', 'd2']])
    expect(withIds({ d1: 'd1', n: 5, list: [{ d1: null }] }, ids)).toEqual({ d2: 'd2', n: 5, list: [{ d2: null }] })
    const v = { d1: 1 }
    expect(withIds(v, new Map())).toBe(v)
  })
})

describe('recorded calls a test did not make', () => {
  const list = () => replayGeom('fixtures/x.json', {
    t: [{ op: 'nest.footprint', request: { a: 1 }, reply: 1 }, { op: 'nest.arrange', request: { a: 2 }, reply: 2 }],
  })

  it('lists the recorded calls after the last one the test made', async () => {
    const r = list()
    r.start('t')
    expect(r.unused()).toEqual(['call 1 (nest.footprint)', 'call 2 (nest.arrange)'])
    await r.call('nest.footprint', { a: 1 })
    expect(r.unused()).toEqual(['call 2 (nest.arrange)'])
    await r.call('nest.arrange', { a: 2 })
    expect(r.unused()).toEqual([])
    expect(r.stale).toEqual([])
  })

  it('lists nothing for a test with no recording, and starts again with the next test', async () => {
    const r = list()
    r.start('none')
    expect(r.unused()).toEqual([])
    r.start('t')
    await r.call('nest.footprint', { a: 1 })
    r.start('t')
    expect(r.unused()).toHaveLength(2)
  })
})

describe('writing a recording', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'sx-rec-'))

  it('writes the calls a run recorded', () => {
    const d = dir()
    const file = join(d, 'x.json')
    expect(writeRecording(file, { t: [{ op: 'a', request: 1, reply: 2 }] }, false)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ t: [{ op: 'a', request: 1, reply: 2 }] })
    rmSync(d, { recursive: true })
  })

  it('writes a project archive in a request as its files, and replays it against the live bytes', async () => {
    const d = dir()
    const file = join(d, 'x.json')
    const model = { name: '3D/3dmodel.model', data: `<model>${'<vertex x="1" y="2" z="3"/>'.repeat(40)}</model>` }
    const bytes = await zipCompressed([model])
    const request = JSON.parse(JSON.stringify({ data: { bytes } })) as unknown
    writeRecording(file, { t: [{ op: 'format.read3mf', request, reply: { ok: true } }] }, false)
    const written = JSON.parse(readFileSync(file, 'utf8')) as { t: { request: unknown }[] }
    expect(written.t[0]!.request).toEqual({ data: { bytes: { zip: { [model.name]: model.data } } } })
    const r = replayGeom(file)
    r.start('t')
    expect(await r.call('format.read3mf', { data: { bytes: zip([model]) } })).toEqual({ ok: true })
    expect(r.stale).toEqual([])
    rmSync(d, { recursive: true })
  })

  it('leaves the fixture alone when the run recorded no calls', () => {
    const d = dir()
    const file = join(d, 'x.json')
    writeFileSync(file, '{"keep":[]}\n')
    expect(writeRecording(file, {}, false)).toBe(false)
    expect(writeRecording(file, { t: [] }, false)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{"keep":[]}\n')
    const none = join(d, 'none.json')
    expect(writeRecording(none, {}, false)).toBe(false)
    expect(existsSync(none)).toBe(false)
    rmSync(d, { recursive: true })
  })
})
