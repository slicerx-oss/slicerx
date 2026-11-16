// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The feature filament table over the app link: a client reads it for the plate or some objects and sets rows the way
// a pick in the Color tab does, and the answer reads the table back.
import type { SliceResult } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { FEATURE_FILAMENT_ROWS } from '../src/plate/feature-filaments'
import { get, set } from '../src/state/store'

type Row = { feature: string; key: string; value: number | null; source: string; changed: boolean; printedWith: number[] | null }
type Reply = { summary: string; output: { scope: Record<string, unknown>; rows: Row[] } }

const obj = (id: string, slot: number, extra: Record<string, unknown> = {}) => ({ id, name: `Box ${id}`, handle: { id, parts: [{ name: 'body', slot }] }, parts: [], colors: [], ...extra }) as never
const row = (r: Reply, feature: string) => r.output.rows.find((x) => x.feature === feature)!

beforeEach(() => {
  set({ plate: [obj('a', 1), obj('b', 2), obj('c', 1, { instanceOf: 'a' })], plates: [{ id: 'plate', name: 'Plate', objects: [], settings: {} }] as never, activePlate: 'plate', printerSlots: [], slotSetup: {}, objectSettings: {}, overrides: {}, slice: { status: 'idle' }, plateLoading: false, historyEdit: null, rollback: null, dragging: false, liveEdit: false })
})

describe('feature_filaments over the app link', () => {
  it('is a read and an edit on the link', () => {
    expect(APP_LINK_METHODS['feature_filaments.get']).toBe('read')
    expect(APP_LINK_METHODS['feature_filaments.set']).toBe('edit')
  })

  it("reads every row for the plate, the object's filament by default, in the table's order", async () => {
    const r = (await runCall('feature_filaments.get', {})) as Reply
    expect(r.output.scope).toEqual({ kind: 'plate' })
    expect(r.output.rows.map((x) => x.key)).toEqual(FEATURE_FILAMENT_ROWS.map((d) => d.key))
    for (const x of r.output.rows) expect(x).toMatchObject({ value: 0, source: 'plate', changed: false, printedWith: null })
  })

  it('sets the plate by feature name or setting key and reads it back, and null goes back to the inherited value', async () => {
    const r = (await runCall('feature_filaments.set', { filaments: { sparseInfill: 2, support_filament: 2 } })) as Reply
    expect(get().overrides).toEqual({ sparse_infill_filament_id: 2, support_filament: 2 })
    expect(row(r, 'sparseInfill')).toMatchObject({ value: 2, changed: true })
    expect(row(r, 'support')).toMatchObject({ value: 2, changed: true })
    await runCall('feature_filaments.set', { filaments: { sparseInfill: null } })
    expect(get().overrides).toEqual({ support_filament: 2 })
  })

  it('sets the objects named, each source once, and reads Mixed across objects that differ', async () => {
    const r = (await runCall('feature_filaments.set', { objects: ['Box c'], filaments: { outerWall: 2 } }).catch((e: unknown) => e)) as { code?: string }
    // an instance has no name of its own to find it by: ids work, and the source object's name
    expect(r.code).toBe('not_found')
    const set1 = (await runCall('feature_filaments.set', { objects: ['c'], filaments: { outerWall: 2 } })) as Reply
    expect(get().objectSettings).toEqual({ a: { outer_wall_filament_id: 2 } })
    expect(get().overrides).toEqual({})
    expect(set1.output.scope).toEqual({ kind: 'objects', objects: ['c'] })
    expect(row(set1, 'outerWall')).toMatchObject({ value: 2, source: 'own', changed: true })
    const both = (await runCall('feature_filaments.get', { objects: ['Box a', 'b'] })) as Reply
    expect(row(both, 'outerWall')).toMatchObject({ value: null, source: 'mixed' })
  })

  it('reads what each feature printed with from the current slice only', async () => {
    set({ slice: { status: 'done', stale: false, result: { featureFilaments: [{ object: 'a', name: 'Box a', features: { outerWall: [1, 2] } }] } as unknown as SliceResult } })
    expect(row((await runCall('feature_filaments.get', {})) as Reply, 'outerWall').printedWith).toEqual([1, 2])
    set({ slice: { ...(get().slice as { status: 'done'; stale: boolean; result: SliceResult }), stale: true } })
    expect(row((await runCall('feature_filaments.get', {})) as Reply, 'outerWall').printedWith).toBeNull()
  })

  it('checks every row before any change', async () => {
    for (const filaments of [{ outerWall: 2, wall_loops: 3 }, { outerWall: 2, innerWall: 3 }, { outerWall: -1 }, { outerWall: 1.5 }, {}]) {
      await expect(runCall('feature_filaments.set', { filaments })).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(runCall('feature_filaments.set', { objects: ['nope'], filaments: { outerWall: 1 } })).rejects.toMatchObject({ code: 'not_found' })
    expect(get().overrides).toEqual({})
    expect(get().objectSettings).toEqual({})
  })

  it('waits for a slice or an edit in progress', async () => {
    set({ slice: { status: 'running' } as never })
    await expect(runCall('feature_filaments.set', { filaments: { outerWall: 2 } })).rejects.toMatchObject({ code: 'busy' })
    expect(get().overrides).toEqual({})
  })
})
