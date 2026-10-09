// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model tree's filter: object names keep the whole object, step names keep the matching steps, and a few words
// find a kind of step or object.
import { describe, expect, it } from 'vitest'
import type { Step, StepParams } from '../src/cad/history/model'
import { filterTree, startsFilter } from '../src/workspaces/design/tree-filter'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const step = (id: string, params: unknown, extra: Partial<Step> = {}): Step => ({ id, part: -1, transform: I, params: params as StepParams, ...extra })
const OBJECTS = [
  { id: 'a', name: 'Pi enclosure', history: { steps: [step('1', { op: 'shape.extrude', shape: { type: 'sketch', loops: [[]] }, spec: { distanceMm: 30, operation: 'new' } }), step('2', { op: 'shell', open: [{}], wallMm: 2 }, { broken: 'gone' }), step('3', { op: 'edge.fillet', edges: [{}], radiusMm: 5 }, { suppressed: true })] } },
  { id: 'b', name: 'Bracket', history: { steps: [step('4', { op: 'face.push', at: [0, 0, 0], normal: [0, 0, 1], distanceMm: 5 })] } },
  { id: 'c', name: 'Scan' },
]
const view = (q: string) => Object.fromEntries([...filterTree(OBJECTS, q)].map(([id, s]) => [id, s.show ? (s.steps ? [...s.steps] : 'all') : 'hidden']))

describe('the tree filter', () => {
  it('shows everything when empty', () => {
    expect(view('')).toEqual({ a: 'all', b: 'all', c: 'all' })
  })
  it('keeps a matching object whole and only the matching steps of others', () => {
    expect(view('brack')).toEqual({ a: 'hidden', b: 'all', c: 'hidden' })
    expect(view('fillet')).toEqual({ a: [2], b: 'hidden', c: 'hidden' })
    expect(view('PULL')).toEqual({ a: 'hidden', b: [0], c: 'hidden' })
  })
  it('finds broken and turned off steps, sketches and meshes by name', () => {
    expect(view('broken')).toEqual({ a: [1], b: 'hidden', c: 'hidden' })
    expect(view('off')).toEqual({ a: [2], b: 'hidden', c: 'hidden' })
    expect(view('sketch')).toEqual({ a: [0], b: 'hidden', c: 'hidden' })
    expect(view('mesh')).toEqual({ a: 'hidden', b: 'hidden', c: 'all' })
  })
  it('starts on a printable key only', () => {
    const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => startsFilter({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods })
    expect([k('b'), k('7'), k(' '), k('ArrowDown'), k('F2'), k('b', { ctrlKey: true }), k('2', { altKey: true })]).toEqual([true, true, false, false, false, false, false])
  })
})
