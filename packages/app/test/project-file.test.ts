// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { FileRef, Host } from '@slicerx/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/export/threemf', async (orig) => ({ ...(await orig<object>()), writeProjectCompressed: async () => new Uint8Array([1, 2, 3]) }))

const { saveProject } = await import('../src/export/actions')
const { clearProject } = await import('../src/project/new')
const { windowTitle } = await import('../src/project/title')
const { isDirty, markClean, startDirtyTracking } = await import('../src/project/unsaved')
const { history } = await import('../src/plate/history')
const { get, set } = await import('../src/state/store')

const entry = (id: string) => ({ id, name: id, handle: { id, hash: id, name: id, triangles: 1, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as never

function fakeHost() {
  const calls: string[] = []
  const ref = (path: string): FileRef => ({ id: String(calls.length), name: path.split('/').pop() ?? path, size: 3, path })
  const files = {
    save: vi.fn(async () => {
      calls.push('dialog')
      return ref('/p/box.sx3mf')
    }),
    saveTo: vi.fn(async (r: FileRef) => {
      calls.push(`write ${r.path}`)
      return r
    }),
  }
  return { host: { files } as unknown as Host, calls }
}

describe('project file', () => {
  beforeEach(() => {
    startDirtyTracking()
    clearProject()
  })

  it('asks where on the first save, then writes there, and Save as always asks', async () => {
    const { host, calls } = fakeHost()
    set({ plate: [entry('a')] })
    expect(await saveProject(host)).toBe(true)
    expect(get().projectFile?.path).toBe('/p/box.sx3mf')
    expect(isDirty()).toBe(false)
    expect(await saveProject(host)).toBe(true)
    expect(await saveProject(host, { as: true })).toBe(true)
    expect(calls).toEqual(['dialog', 'write /p/box.sx3mf', 'dialog'])
  })

  it('a new project is one empty plate with no file and no undo', () => {
    set({ plate: [entry('a')], projectFile: { id: '1', name: 'x.sx3mf', size: 1, path: '/x.sx3mf' } })
    set({ plates: [...get().plates, { id: 'plate-2', name: 'Plate 2', objects: [entry('b')], settings: { sequence: 'by-layer' } }] })
    clearProject()
    const s = get()
    expect([s.plate.length, s.plates.length, s.activePlate, s.projectFile]).toEqual([0, 1, 'plate-1', null])
    expect(history().canUndo()).toBe(false)
    expect(isDirty()).toBe(false)
    markClean()
  })

  it('titles the window with the file and marks unsaved changes', () => {
    expect(windowTitle(null, false)).toBe('SlicerX')
    expect(windowTitle(null, true)).toBe('*Untitled · SlicerX')
    expect(windowTitle({ name: 'box.sx3mf', path: '/p/box.sx3mf' }, false)).toBe('/p/box.sx3mf · SlicerX')
    expect(windowTitle({ name: 'box.sx3mf', path: '/p/box.sx3mf' }, true)).toBe('*/p/box.sx3mf · SlicerX')
  })
})
