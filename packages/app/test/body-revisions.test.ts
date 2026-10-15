// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it, vi } from 'vitest'
import { bodyRevisions } from '../src/cad/body-revisions'
import { appDesignHost } from '../src/cad/design-host'
import { get, set, type PlateEntry } from '../src/state/store'
import { identity } from '../src/plate/transform'
import { useGeomEngine } from './geom-engine'
import { toPart } from '../src/cad/history/ops'

useGeomEngine('design-host-replies')

const entry = (): PlateEntry => ({
  id: 'body', name: 'Body', parts: [], colors: [], transform: identity(),
  handle: { id: 'mesh', hash: 'mesh', name: 'Body', triangles: 0, bboxMm: [0, 0, 0], openEdges: 0, parts: [] },
})

beforeEach(() => set({ plate: [], selection: null, selectedIds: [] }))

it('observes an edit and Undo between client reads', () => {
  const original = entry()
  set({ plate: [original] })
  const revision = bodyRevisions.current(original.id)
  set({ plate: [{ ...original, parts: [] }] })
  set({ plate: [original] })
  expect(() => bodyRevisions.assert(original.id, revision)).toThrow(/changed or was replaced/)
})

it('preserves references across selection and color changes', () => {
  const original = entry()
  set({ plate: [original] })
  const revision = bodyRevisions.current(original.id)
  set({ selection: original.id, selectedIds: [original.id] })
  set({ plate: get().plate.map(e => ({ ...e, colors: ['#ffffff'] })) })
  expect(bodyRevisions.current(original.id)).toBe(revision)
})

it('invalidates a removed body even if the same entry is restored', () => {
  const original = entry()
  set({ plate: [original] })
  const revision = bodyRevisions.current(original.id)
  set({ plate: [] })
  expect(() => bodyRevisions.current(original.id)).toThrow()
  set({ plate: [original] })
  expect(bodyRevisions.current(original.id)).not.toBe(revision)
})

it('invalidates a face reference when its world placement changes', () => {
  const original = entry()
  set({ plate: [original] })
  const revision = bodyRevisions.current(original.id)
  const transform = identity()
  transform[12] = 12
  set({ plate: [{ ...original, transform }] })
  expect(() => bodyRevisions.assert(original.id, revision)).toThrow()
})

it('refuses a stale empty-body edit before loading replacement geometry', async () => {
  const loadParts = vi.fn(async () => entry().handle)
  const host = appDesignHost({ loadParts })
  const design = await host.create('Empty', [])
  const revision = host.revision!(design.id)
  await host.replay(design)
  await expect(host.add(design, -1, { op: 'parts.add', label: 'Add part', parts: [] }, undefined, { expectedRevision: revision })).rejects.toMatchObject({ code: 'stale_body' })
  expect(loadParts).not.toHaveBeenCalled()
})

it('checks again after loading geometry before committing an empty-body edit', async () => {
  let loaded!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { loaded = resolve })
  const ready = new Promise<void>(resolve => { release = resolve })
  const host = appDesignHost({ loadParts: async () => { loaded(); await ready; return entry().handle } })
  const design = await host.create('Empty', [])
  const revision = host.revision!(design.id)
  const pending = host.add(design, -1, { op: 'parts.add', label: 'Add part', parts: [{ name: 'Candidate', slot: 1, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }] }, undefined, { expectedRevision: revision })
  const refusal = expect(pending).rejects.toMatchObject({ code: 'stale_body' })
  await started
  const concurrent = { ...entry(), id: design.id }
  set({ plate: [concurrent] })
  const committed = host.revision!(design.id)
  release()
  await refusal
  expect(get().plate).toEqual([concurrent])
  expect(host.revision!(design.id)).toBe(committed)
})

it('keeps surface metadata through both app replay conversion paths', async () => {
  const mesh = { name: 'Hole wall', slot: 1, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [123], table: [{ kind: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], radius: 3 }] } }
  const converted = toPart(mesh)
  expect(converted.faces?.keys).toEqual([123])
  expect(converted.faces?.table[0]).toMatchObject({ kind: 'cylinder', radius: 3 })
  const host = appDesignHost({ loadParts: async () => entry().handle })
  const design = await host.create('Hole wall', [mesh])
  expect(design.parts[0]?.faces?.keys).toEqual([123])
  await host.replay(design)
  expect(design.parts[0]?.faces?.table[0]).toMatchObject({ kind: 'cylinder', radius: 3 })
})

it.each([true, false])('captures a detached app commit receipt with an initially empty body: %s', async (empty) => {
  const mesh = { name: 'Part', slot: 1, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }
  const host = appDesignHost({ loadParts: async () => entry().handle })
  const d = await host.create('Body', empty ? [] : [mesh])
  const first = host.addWithReceipt!(d, -1, { op: 'parts.add', label: 'Add part', parts: [mesh] }, undefined, { expectedRevision: host.revision!(d.id) })
  await first.then(() => host.add(d, -1, { op: 'parts.add', label: 'Add part', parts: [mesh] }))
  const receipt = await first
  expect(receipt.design.parts).toHaveLength(empty ? 1 : 2)
  expect(receipt.design.history.steps).toHaveLength(1)
  expect(receipt.step.id).toBe(receipt.design.history.steps[0]!.id)
  expect(receipt.revision).not.toBe(host.revision!(d.id))
  ;(receipt.design.parts[0]!.positions as number[])[0] = 100
  expect(host.get(d.id).parts[0]!.positions[0]).toBe(0)
})
