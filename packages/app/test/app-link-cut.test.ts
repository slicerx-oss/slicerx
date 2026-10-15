// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { APP_LINK_METHODS, runCall, useDesignHost } from '../src/app-link/methods'
import { setGeomProvider } from '../src/geom/client'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { identity } from '../src/plate/transform'
import { get, set } from '../src/state/store'

const part = boxMesh(20,20,20)
const host = { loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, name, hash: name, triangles: parts.reduce((n,p) => n + p.indices.length / 3, 0), bboxMm: [20,20,20], openEdges: 0, parts: [] }) }
type Answer = { summary: string; output: { changed: boolean; removed: string; ids: string[]; objects: unknown[]; warnings: string[] } }
const read = () => runCall('plate.list', {}) as Promise<{ objects: { id: string }[] }>

beforeEach(async () => {
  set({ plate: [{ id: 'body', name: 'Body', handle: await host.loadParts('Body', [part]), parts: [part], colors: ['#ffffff'], transform: identity(), printable: false }], plates: [], activePlate: 'plate', objectSettings: { body: { wall_loops: 4 } }, selection: 'body', selectedIds: ['body'], historyEdit: null, rollback: null })
  const mesh = (p: MeshPart) => ({ positions: Array.from(p.positions), indices: Array.from(p.indices) })
  setGeomProvider({ call: async <T>() => ({ below: mesh(boxMesh(20,20,8)), above: mesh(boxMesh(20,20,12)), report: { connectors: [], warnings: [] } }) as T })
  await useDesignHost(host)
  history().clear()
})
afterEach(() => setGeomProvider(null))

it('cuts through the registered method and independently reads the resulting objects and Undo', async () => {
  const before = get().plate
  expect(APP_LINK_METHODS['project.cut']).toBe('edit')
  const out = await runCall('project.cut', { object: 'body', plane: { axis: 'z', at: 0 } }, { id: 'client', name: 'Workshop' }) as Answer
  expect(out.output).toMatchObject({ changed: true, removed: 'body' })
  expect(out.output.objects).toEqual((await read()).objects)
  expect(out.output.objects).toHaveLength(2)
  expect(out.output.objects).toEqual(expect.arrayContaining([expect.objectContaining({ printable: false, settings: { wall_loops: 4 } })]))
  expect(get().toast?.text).toContain('Workshop: Cut Body')
  get().toast?.action?.run()
  expect(get().plate).toEqual(before)
  expect(history().canUndo()).toBe(false)
})

it('refuses ambiguous names, locked targets and invalid fields without changing the plate', async () => {
  const entry = get().plate[0]!
  set({ plate: [entry, { ...entry, id: 'copy' }] })
  const args = { object: 'Body', plane: { axis: 'z', at: 0 } }
  await expect(runCall('project.cut', args)).rejects.toMatchObject({ code: 'invalid_input' })
  set({ plate: [{ ...entry, locked: true }] })
  const before = get().plate
  await expect(runCall('project.cut', { ...args, object: 'body' })).rejects.toMatchObject({ code: 'refused' })
  await expect(runCall('project.cut', { ...args, object: 'body', unexpected: true })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(get().plate).toBe(before)
})

