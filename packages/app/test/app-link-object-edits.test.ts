// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { history } from '../src/plate/history'
import { get, set, type PlateEntry } from '../src/state/store'
import { identity } from '../src/plate/transform'

const mesh = { name: 'Body', slot: 1, positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 5]), indices: new Uint32Array([0, 1, 2, 0, 1, 3]) }
const entry = (id: string): PlateEntry => ({ id, name: 'Box', parts: [mesh], colors: [], transform: identity(), handle: { id, hash: id, name: 'Box', triangles: 2, bboxMm: [10, 20, 5], openEdges: 0, parts: [{ name: 'Body', triangles: 2, slot: 1 }] } })
type Row = { id: string; locked: boolean; printable: boolean; minMm: number[]; sizeMm: number[]; settings: Record<string, unknown> }
type Reply = { objects: Row[]; output: { objects: Row[] } }
const call = (method: string, args: Record<string, unknown>) => runCall(method, args, { id: 'client', name: 'Print Helper' }) as Promise<Reply>
const read = async () => (await call('plate.list', {})).objects

beforeEach(() => {
  set({ plate: [entry('one'), { ...entry('copy'), instanceOf: 'one' }], bed: { widthMm: 256, depthMm: 200, heightMm: 200 }, objectSettings: { one: { fill_density: '30%' } }, historyEdit: null, rollback: null, toast: null })
  history().clear()
})

it('sets lock and print state on one copy, reads both states through the tool, and undoes each edit', async () => {
  const locked = await call('project.lock', { object: 'copy' })
  expect(locked.output.objects).toMatchObject([{ id: 'copy', locked: true, printable: true, settings: { fill_density: '30%' } }])
  expect((await read()).map((o) => o.locked)).toEqual([false, true])
  expect(history().snapshots()).toHaveLength(1)
  await call('project.lock', { object: 'copy', locked: true })
  expect(history().snapshots()).toHaveLength(1)
  await expect(call('project.center', { object: 'copy' })).rejects.toMatchObject({ code: 'refused' })
  const hidden = await call('project.printable', { object: 'copy', printable: false })
  expect(hidden.output.objects).toMatchObject([{ id: 'copy', locked: true, printable: false }])
  expect((await read()).map((o) => o.printable)).toEqual([true, false])
  expect(history().snapshots()).toHaveLength(2)
  history().undo()
  expect((await read())[1]).toMatchObject({ locked: true, printable: true })
  history().undo()
  expect((await read())[1]).toMatchObject({ locked: false, printable: true })
})

it('centers only the requested copy on rectangular and round beds, with tool read-back and Undo', async () => {
  const before = get().plate
  const centered = await call('project.center', { object: 'copy' })
  expect(centered.output.objects).toMatchObject([{ id: 'copy', minMm: [123, 90, 0], sizeMm: [10, 20, 5] }])
  expect(get().plate[0]).toBe(before[0])
  await call('project.center', { object: 'copy' })
  expect(history().snapshots()).toHaveLength(1)
  history().undo()
  expect(get().plate).toBe(before)
  set({ bed: { widthMm: 200, depthMm: 200, heightMm: 200, round: true } })
  expect((await call('project.center', { object: 'one' })).output.objects[0]!.minMm).toEqual([95, 90, 0])
})

it('retains existing transform read-back in the MCP response envelope', async () => {
  for (const [method, args] of [['project.move', { x: 50, y: 60 }], ['project.rotate', { rotate: [0, 0, 90] }], ['project.scale', { scale: 2 }]] as const) {
    const result = await call(method, { object: 'one', ...args })
    expect(result.output.objects).toEqual(result.objects)
    expect(result.output.objects[0]).toMatchObject({ id: 'one', sizeMm: expect.any(Array), locked: false, printable: true })
  }
})

it('validates inputs and refuses an edit or rolled-back timeline without mutation', async () => {
  const before = get().plate
  await expect(call('project.lock', { object: 'one', locked: 'yes' })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(call('project.lock', { object: 'one', locked: null })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(call('project.printable', { object: 'one' })).rejects.toMatchObject({ code: 'invalid_input' })
  set({ historyEdit: { objectId: 'one' } as never })
  await expect(call('project.lock', { object: 'one' })).rejects.toMatchObject({ code: 'busy' })
  set({ historyEdit: null, rollback: {} as never })
  await expect(call('project.center', { object: 'copy' })).rejects.toMatchObject({ code: 'busy' })
  expect(get().plate).toBe(before)
})

it('splits a named object through both app-link methods and reads the resulting parts and ids', async () => {
  await useDesignHost({ loadParts: async (name, parts) => ({ id: name, hash: name, name, triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), bboxMm: [40, 20, 5], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })) }) })
  const two = { ...mesh, positions: Float32Array.from([...mesh.positions, ...Array.from(mesh.positions, (v, i) => i % 3 === 0 ? v + 30 : v)]), indices: Uint32Array.from([...mesh.indices, ...Array.from(mesh.indices, (v) => v + 4)]) }
  const src = { ...entry('one'), parts: [two] }
  set({ plate: [src] })
  history().clear()
  const parts = await call('project.split_parts', { object: 'one' })
  expect(parts.output.objects).toMatchObject([{ id: 'one', parts: 2 }])
  expect(parts.output.objects).toEqual(await read())
  history().undo()
  expect(get().plate[0]).toBe(src)
  const objects = await call('project.split_objects', { object: 'one' })
  expect(objects.output.objects).toHaveLength(2)
  expect(objects.output.objects).toEqual(await read())
  expect(get().plate.some((p) => p.id === 'one')).toBe(false)
  await expect(call('project.split_objects', { object: get().plate[0]!.id })).rejects.toMatchObject({ code: 'refused' })
  history().undo()
  expect(get().plate[0]).toBe(src)
})
