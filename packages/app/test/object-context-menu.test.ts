// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The right-click menu on an object: Rename, Object settings, Merge, Split and Mirror beside the existing verbs, each
// shown only where its command is on, each running that command, and Delete still last.
import type { Host, MeshHandle } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerCommands } from '../src/commands/registry'
import { plateCommands } from '../src/plate/commands'
import { boxMesh } from '../src/plate/mesh-ops'
import { onRenameRequest } from '../src/plate/object-list'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { SelectionMenu } from '../src/workspaces/prepare/selection-bar'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const at = (x: number) => compose({ position: [x, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const one = (id: string, x = 50): PlateEntry => ({ id, name: id, handle: handle(id), parts: [boxMesh(20, 20, 20)], colors: ['#bd93f9'], transform: at(x) })
/** One object in two pieces 40 mm apart. */
const two = (id: string): PlateEntry => {
  const a = boxMesh(10, 10, 10)
  const b = { ...a, positions: a.positions.map((p, i) => (i % 3 === 0 ? p + 40 : p)) }
  return { ...one(id), parts: [a, b], colors: ['#bd93f9', '#ebebe6'] }
}
const host = { slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host

let el: HTMLDivElement
let root: Root
let off: () => void
const menu = () => document.querySelector('[data-testid="slice-ctx"]') as HTMLElement | null
const item = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const labels = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((b) => b.textContent)
const show = () => flushSync(() => root.render(createElement(SelectionMenu, { at: { x: 40, y: 40 }, onClose: () => undefined, label: 'Menu' })))

beforeEach(() => {
  off = registerCommands(plateCommands(() => 'slicerx' as never, host))
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})
afterEach(() => {
  flushSync(() => root.unmount())
  el.remove()
  off()
  document.body.replaceChildren()
})

describe('the object context menu', () => {
  it('offers Split to objects and Split to parts for a multi-piece object, Mirror and Rename, and runs them', async () => {
    set({ plate: [two('a'), one('b', 120)], selection: 'a', selectedIds: ['a'], settingsScope: 'plate' })
    show()
    expect(item('slice-ctx-split-objects')).not.toBeNull()
    expect(item('slice-ctx-split-parts')).toBeNull()
    expect(item('slice-ctx-merge')).toBeNull()
    for (const id of ['slice-ctx-mirror-x', 'slice-ctx-mirror-y', 'slice-ctx-mirror-z', 'slice-ctx-rename', 'slice-ctx-object-settings']) expect(item(id), id).not.toBeNull()

    // Mirror runs the command: the object's transform changes
    const before = [...get().plate[0]!.transform]
    item('slice-ctx-mirror-x')!.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(get().plate[0]!.transform).not.toEqual(before)

    // Rename asks the row to start
    let asked = false
    const stop = onRenameRequest('a', () => (asked = true))
    item('slice-ctx-rename')!.click()
    stop()
    expect(asked).toBe(true)

    // Object settings switches Print settings to the object
    item('slice-ctx-object-settings')!.click()
    expect(get().settingsScope).toBe('objects')

    // Split runs the command: the two pieces are two objects
    item('slice-ctx-split-objects')!.click()
    await new Promise((r) => setTimeout(r, 20))
    expect(get().plate.map((p) => p.name)).toEqual(['a 1', 'a 2', 'b'])
  })

  it('offers Split to parts for an object whose one part is in two pieces', () => {
    const a = boxMesh(10, 10, 10)
    const joined = { ...a, positions: new Float32Array([...a.positions, ...a.positions.map((p, i) => (i % 3 === 0 ? p + 40 : p))]), indices: new Uint32Array([...a.indices, ...a.indices.map((i) => i + a.positions.length / 3)]) }
    set({ plate: [{ ...one('a'), parts: [joined] }], selection: 'a', selectedIds: ['a'] })
    show()
    expect(item('slice-ctx-split-parts')).not.toBeNull()
    expect(item('slice-ctx-split-objects')).not.toBeNull()
  })

  it('offers neither Split for a single piece', () => {
    set({ plate: [one('a')], selection: 'a', selectedIds: ['a'] })
    show()
    expect(item('slice-ctx-split-objects')).toBeNull()
    expect(item('slice-ctx-split-parts')).toBeNull()
    expect(item('slice-ctx-mirror-z')).not.toBeNull()
  })

  it('offers Merge, and not Rename or Mirror, for two selected objects, and runs it', async () => {
    set({ plate: [one('a'), one('b', 120)], selection: 'a', selectedIds: ['a', 'b'] })
    show()
    expect(item('slice-ctx-merge')).not.toBeNull()
    for (const id of ['slice-ctx-rename', 'slice-ctx-mirror-x', 'slice-ctx-split-objects']) expect(item(id), id).toBeNull()
    item('slice-ctx-merge')!.click()
    await new Promise((r) => setTimeout(r, 20))
    expect(get().plate.map((p) => p.id)).toEqual(['a'])
    expect(get().plate[0]!.parts).toHaveLength(2)
  })

  it('keeps the existing verbs in order, puts the new ones after Duplicate, and Delete last', () => {
    set({ plate: [two('a')], selection: 'a', selectedIds: ['a'] })
    show()
    const l = labels()
    const idx = (t: string) => l.findIndex((x) => x?.startsWith(t))
    expect(idx('Arrange')).toBeLessThan(idx('Skip'))
    expect(idx('Duplicate')).toBeLessThan(idx('Rename'))
    expect(idx('Rename')).toBeLessThan(idx('Split to objects'))
    expect(idx('Split to objects')).toBeLessThan(idx('Along X'))
    expect(idx('Along Z')).toBeLessThan(idx('Delete'))
    expect(l[l.length - 1]).toMatch(/^Delete/)
  })

  it('shows nothing extra when no command is on', () => {
    off()
    off = registerCommands([])
    set({ plate: [one('a')], selection: 'a', selectedIds: ['a'] })
    show()
    expect(item('slice-ctx-rename')).toBeNull()
    expect(item('slice-ctx-mirror-x')).toBeNull()
  })
})
