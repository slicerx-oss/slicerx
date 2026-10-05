// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { memoryStore } from '../src/kv'
import { createMemorySyncServer, createProfileSync, mergeRecords, type SyncedProfile } from '../src/sync/index'

const USER = '00000000-0000-4000-8000-0000000000a1'
const OTHER = '00000000-0000-4000-8000-0000000000a2'
const PHONE = '00000000-0000-4000-8000-00000000d001'
const DESK = '00000000-0000-4000-8000-00000000d002'
const fixed = () => new Date('2026-01-01T00:00:00Z')

function devices() {
  const server = createMemorySyncServer()
  const make = (deviceId: string, store = memoryStore(), userId = USER) =>
    createProfileSync({ transport: server.transportFor(userId), store, userId, deviceId, now: fixed })
  return { server, make }
}

async function mustSync(s: ReturnType<typeof createProfileSync>) {
  const r = await s.sync()
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
  return r.value
}

describe('profile sync', () => {
  it('carries a profile from one device to another', async () => {
    const { make } = devices()
    const phone = make(PHONE)
    const desk = make(DESK)
    const saved = await phone.save('profile', { kind: 'process', name: '0.20 mm Standard', settings: { layer_height: 0.2 } })
    expect(saved.ok).toBe(true)
    expect(phone.pendingCount()).toBe(1)
    expect((await mustSync(phone)).pushed).toBe(1)
    expect(phone.pendingCount()).toBe(0)

    await mustSync(desk)
    const got = desk.list('profile')
    expect(got).toHaveLength(1)
    expect(got[0]?.settings).toEqual({ layer_height: 0.2 })
    expect(got[0]?.updatedBy).toBe(PHONE)
    expect(got[0]?.revision).toBeGreaterThan(0)
  })

  it('merges edits to different settings keys made on two devices', async () => {
    const { make } = devices()
    const phone = make(PHONE)
    const desk = make(DESK)
    const p = await phone.save('profile', { kind: 'process', name: 'Draft', settings: { layer_height: 0.2, wall_loops: 2 } })
    if (!p.ok) throw new Error('save failed')
    await mustSync(phone)
    await mustSync(desk)

    await phone.save('profile', { id: p.value.id, kind: 'process', name: 'Draft', settings: { layer_height: 0.28, wall_loops: 2 } })
    await desk.save('profile', { id: p.value.id, kind: 'process', name: 'Draft', settings: { layer_height: 0.2, wall_loops: 4 } })
    await mustSync(phone)
    const report = await mustSync(desk)
    expect(report.merged).toBe(1)
    expect(desk.conflicts()).toEqual([])
    await mustSync(phone)
    for (const s of [phone, desk]) {
      expect(s.get('profile', p.value.id)?.settings).toEqual({ layer_height: 0.28, wall_loops: 4 })
    }
  })

  it('keeps a real conflict for the user and settles it either way', async () => {
    const { make } = devices()
    const phone = make(PHONE)
    const desk = make(DESK)
    const p = await phone.save('profile', { kind: 'filament', name: 'Generic PLA', settings: { nozzle_temperature: 210 } })
    if (!p.ok) throw new Error('save failed')
    await mustSync(phone)
    await mustSync(desk)

    await phone.save('profile', { id: p.value.id, kind: 'filament', name: 'Generic PLA', settings: { nozzle_temperature: 215 } })
    await desk.save('profile', { id: p.value.id, kind: 'filament', name: 'Generic PLA', settings: { nozzle_temperature: 220 } })
    await mustSync(phone)
    const report = await mustSync(desk)
    expect(report.conflicts).toBe(1)
    const [c] = desk.conflicts()
    expect((c?.mine as SyncedProfile).settings).toEqual({ nozzle_temperature: 220 })
    expect((c?.theirs as SyncedProfile).settings).toEqual({ nozzle_temperature: 215 })

    await desk.resolve('profile', p.value.id, 'mine')
    await mustSync(desk)
    await mustSync(phone)
    expect(phone.get('profile', p.value.id)?.settings).toEqual({ nozzle_temperature: 220 })

    await phone.save('profile', { id: p.value.id, kind: 'filament', name: 'Generic PLA', settings: { nozzle_temperature: 205 } })
    await desk.save('profile', { id: p.value.id, kind: 'filament', name: 'Generic PLA', settings: { nozzle_temperature: 200 } })
    await mustSync(phone)
    await mustSync(desk)
    await desk.resolve('profile', p.value.id, 'theirs')
    expect(desk.get('profile', p.value.id)?.settings).toEqual({ nozzle_temperature: 205 })
    expect(desk.pendingCount()).toBe(0)
  })

  it('keeps edits made offline across a restart and sends them later', async () => {
    const { server, make } = devices()
    const store = memoryStore()
    const first = make(PHONE, store)
    await first.save('printer', { name: 'Bay 1', driver: 'moonraker', model: 'Example Core XY' })
    server.goOffline(1)
    const r = await first.sync()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('offline')

    const restarted = make(PHONE, store)
    await restarted.ready
    expect(restarted.pendingCount()).toBe(1)
    expect(restarted.list('printer')[0]?.name).toBe('Bay 1')
    await mustSync(restarted)
    expect(server.rows('printer')).toHaveLength(1)
  })

  it('does not duplicate a change whose answer was lost', async () => {
    const { server, make } = devices()
    const phone = make(PHONE)
    await phone.save('profile', { kind: 'process', name: 'Fine', settings: { layer_height: 0.12 } })
    server.dropNextPushResponse()
    expect((await phone.sync()).ok).toBe(false)
    const report = await mustSync(phone)
    expect(report.conflicts).toBe(0)
    expect(phone.pendingCount()).toBe(0)
    expect(server.rows('profile')).toHaveLength(1)
  })

  it('propagates deletions as tombstones', async () => {
    const { make } = devices()
    const phone = make(PHONE)
    const desk = make(DESK)
    const p = await phone.save('profile', { kind: 'process', name: 'Old' })
    if (!p.ok) throw new Error('save failed')
    await mustSync(phone)
    await mustSync(desk)
    await desk.remove('profile', p.value.id)
    expect(desk.list('profile')).toEqual([])
    await mustSync(desk)
    await mustSync(phone)
    expect(phone.list('profile')).toEqual([])
    expect(phone.list('profile', { includeDeleted: true })).toHaveLength(1)
  })

  it('refuses credentials in printer settings before they leave the device', async () => {
    const { make } = devices()
    const phone = make(PHONE)
    const r = await phone.save('printer', { name: 'Bay 2', settings: { access_code: '12345678' } })
    expect(r.ok).toBe(false)
    expect(phone.pendingCount()).toBe(0)
  })

  it('reports a change the service refuses and keeps the rest going', async () => {
    const { make } = devices()
    const other = make(DESK, memoryStore(), OTHER)
    const theirs = await other.save('printer', { name: 'Not yours' })
    if (!theirs.ok) throw new Error('save failed')
    await mustSync(other)

    const phone = make(PHONE)
    await phone.save('fleet', { name: 'Mixed', printerIds: [theirs.value.id] })
    await phone.save('profile', { kind: 'process', name: 'Fine' })
    const report = await mustSync(phone)
    expect(report.rejected).toBe(1)
    expect(report.pushed).toBe(1)
    expect(phone.rejections()[0]?.code).toBe('23503')
    expect(phone.pendingCount()).toBe(0)
    expect(phone.list('printer')).toEqual([])
  })

  it('keeps accounts apart on one device', async () => {
    const { make } = devices()
    const store = memoryStore()
    const a = make(PHONE, store, USER)
    await a.save('profile', { kind: 'process', name: 'Mine' })
    await mustSync(a)
    const b = make(PHONE, store, OTHER)
    await mustSync(b)
    expect(b.list('profile')).toEqual([])
  })
})

describe('mergeRecords', () => {
  const base = {
    id: 'f',
    deleted: false,
    revision: 1,
    updatedAt: '',
    updatedBy: null,
    name: 'Workshop',
    printerIds: ['a', 'b'],
  }
  it('merges fleet membership changes from both sides', () => {
    const mine = { ...base, printerIds: ['a', 'b', 'c'] }
    const theirs = { ...base, printerIds: ['b'] }
    expect(mergeRecords('fleet', base, mine, theirs)?.printerIds).toEqual(['b', 'c'])
  })
  it('refuses to merge two different names', () => {
    expect(mergeRecords('fleet', base, { ...base, name: 'A' }, { ...base, name: 'B' })).toBeNull()
  })
})
