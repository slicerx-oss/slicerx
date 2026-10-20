// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The part card in the mimir tab acts on the part its reply made: the body selects it and the tab stays, Edit goes to
// Model and opens its newest modeling step (or Transform when it has none), a removed part says so, and a phone has no
// Edit.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PartCard, goneNote, type CreatedPart } from '@slicerx/pilot/ui'
import type { PlateEntry } from '../src/state/store'

const edits = vi.hoisted(() => ({ begin: vi.fn(async (_host: unknown, _id: string, _index: number) => undefined), transform: vi.fn() }))
vi.mock('../src/cad/history/ops', async (orig) => ({ ...(await orig<typeof import('../src/cad/history/ops')>()), beginEdit: edits.begin }))
vi.mock('../src/workspaces/prepare/selection-bar', () => ({ openTransform: edits.transform }))

const { editPart, hasPart, partHandlers, selectPart } = await import('../src/workspaces/mimir/part-actions')
const { get, set } = await import('../src/state/store')

const host = { loadParts: async () => ({ id: 'h', hash: 'h', name: 'h', triangles: 12, bboxMm: [1, 1, 1] as [number, number, number], openEdges: 0, parts: [] }) }

const rect = { op: 'shape.extrude', shape: { type: 'rectangle', widthMm: 40, heightMm: 30 }, distanceMm: 20 }
const fillet = { op: 'edge.fillet', radiusMm: 2 }
const mirror = { op: 'part.mirror', axis: 'x' }
const entry = (id: string, steps: { params: unknown }[] | null): PlateEntry => ({ id, name: id, parts: [], colors: ['#fff'], ...(steps ? { history: { steps: steps.map((s, i) => ({ id: `s${i}`, part: 0, transform: [], ...s })) } } : {}) }) as unknown as PlateEntry

const box: CreatedPart = { id: 'box', name: 'Box', kind: 'box', sizeMm: [40, 30, 20] }
const card = (part: CreatedPart, phone = false) => render(createElement(PartCard, { part, handlers: partHandlers(host, phone) }))

beforeEach(() => {
  edits.begin.mockClear()
  edits.transform.mockClear()
  set({ plate: [entry('box', [{ params: rect }, { params: fillet }, { params: mirror }]), entry('mesh', null)], historyEdit: null, selection: null, selectedIds: [], towerSelected: true, workspace: 'prepare', modelMode: 'mimir' })
})
afterEach(cleanup)

describe('the part card in the mimir tab', () => {
  it('Select highlights the part on the plate', () => {
    card(box)
    fireEvent.click(screen.getByRole('button', { name: 'Select the Box' }))
    expect(get().selection).toBe('box')
    expect(get().selectedIds).toEqual(['box'])
    expect(get().towerSelected).toBe(false)
    // the tab stays open
    expect(get().modelMode).toBe('mimir')
    // the same from code, for any part by id
    selectPart('mesh')
    expect(get().selectedIds).toEqual(['mesh'])
  })

  it('Edit opens the newest modeling step', async () => {
    card(box)
    const edit = screen.getByRole('button', { name: 'Edit the Box' })
    // its tooltip says where it goes
    expect(edit.getAttribute('data-tip-title')).toBe('Edit in Model')
    fireEvent.click(edit)
    // Model opens, with the part in design mode
    expect(get().modelMode).toBe('design')
    expect(get().workspace).toBe('prepare')
    // the mirror (step 3) has no tool of its own, so the fillet (step 2) opens
    await vi.waitFor(() => expect(edits.begin).toHaveBeenCalledWith(host, 'box', 1))
    expect(edits.transform).not.toHaveBeenCalled()
  })

  it('Edit on a part with no modeling step opens Transform', async () => {
    await editPart(host, 'mesh')
    expect(get().modelMode).toBe('design')
    expect(edits.begin).not.toHaveBeenCalled()
    expect(get().selectedIds).toEqual(['mesh'])
    expect(edits.transform).toHaveBeenCalledTimes(1)
    // a history whose steps have no tool of their own opens Transform too
    set({ plate: [entry('flat', [{ params: mirror }])] })
    await editPart(host, 'flat')
    expect(edits.begin).not.toHaveBeenCalled()
    expect(get().selectedIds).toEqual(['flat'])
    expect(edits.transform).toHaveBeenCalledTimes(2)
  })

  it('a removed part says it is gone', () => {
    const lid: CreatedPart = { id: 'lid', name: 'Lid', kind: 'box', sizeMm: [40, 30, 2] }
    expect(hasPart('lid')).toBe(false)
    card(lid)
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Lid' }))
    expect(screen.getByRole('status').textContent).toBe(goneNote(lid))
    fireEvent.click(screen.getByRole('button', { name: 'Select the Lid' }))
    expect(get().selection).toBe(null)
    expect(get().modelMode).toBe('mimir')
    expect(edits.begin).not.toHaveBeenCalled()
    expect(edits.transform).not.toHaveBeenCalled()
    // a part open for editing is off the plate for the moment, and is still in the project
    const original = get().plate[0]!
    set({ plate: get().plate.slice(1), historyEdit: { objectId: 'box', index: 1, original } as never })
    expect(hasPart('box')).toBe(true)
  })

  it('the phone has no Edit', () => {
    expect(partHandlers(host, true).onEdit).toBeUndefined()
    card(box, true)
    expect(screen.queryByRole('button', { name: 'Edit the Box' })).toBeNull()
    // the body still selects
    fireEvent.click(screen.getByRole('button', { name: 'Select the Box' }))
    expect(get().selectedIds).toEqual(['box'])
  })
})
