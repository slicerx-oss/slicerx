// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Steps one call made together share a group (Step.group): the history file keeps it, in the per-object form and the
// timeline form alike, and reads it back; a file saved before groups, or a group that is no group, reads as steps of
// their own; and lastGroup gives the steps one undo takes off the end.
import { describe, expect, it } from 'vitest'
import { historyFiles, IDENTITY, lastGroup, parseHistories, timelineFiles, timelineOf, type History, type Step, type StepParams } from '@slicerx/cad-history'
import { boxMesh } from '../src/plate/mesh-ops'

const cut = (id: string, group?: string): Step => ({
  id,
  part: 0,
  transform: [...IDENTITY],
  params: { op: 'subtract', solids: [{ type: 'box', min: [-1, -1, 4], max: [1, 1, 6] }], label: id } as StepParams,
  ...(group ? { group } : {}),
})
const base = () => [{ ...boxMesh(20, 20, 5), name: 'Block', slot: 1 }]
const history = (...steps: Step[]): History => ({ version: 1, base: base(), steps })
const bytes = (entries: { name: string; data: string | Uint8Array }[]) => new Map(entries.map((e) => [e.name, typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data]))

describe('a group in the history file', () => {
  it('is kept and read back, per object and as a timeline', () => {
    const h = history(cut('a'), cut('b', 'g1'), cut('c', 'g1'))
    const v2 = parseHistories(bytes(historyFiles([{ id: 'x', history: h }], new Map([['x', 1]]))), new Set(['1'])).get('1')!
    expect(v2.steps.map((s) => s.group)).toEqual([undefined, 'g1', 'g1'])
    const v3 = parseHistories(bytes(timelineFiles(timelineOf([{ id: 'x', history: h }]), new Map([['x', 1]]))), new Set(['1'])).get('1')!
    expect(v3.steps.map((s) => s.group)).toEqual([undefined, 'g1', 'g1'])
  })

  it('reads a file saved before groups, and a group that is no group, as steps of their own', () => {
    const h = history(cut('a'), cut('b'))
    const files = bytes(historyFiles([{ id: 'x', history: h }], new Map([['x', 1]])))
    expect(parseHistories(files, new Set(['1'])).get('1')!.steps.every((s) => s.group === undefined)).toBe(true)
    const json = JSON.parse(new TextDecoder().decode(files.get('Metadata/slicerx_history.json'))) as { objects: { steps: Record<string, unknown>[] }[] }
    json.objects[0]!.steps[0]!['group'] = 'not a group!'
    json.objects[0]!.steps[1]!['group'] = 7
    files.set('Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify(json)))
    expect(parseHistories(files, new Set(['1'])).get('1')!.steps.map((s) => s.group)).toEqual([undefined, undefined])
  })
})

describe('the steps one undo takes off', () => {
  it('is the last group, or the last step alone', () => {
    expect(lastGroup([])).toEqual([])
    expect(lastGroup([cut('a'), cut('b')]).map((s) => s.id)).toEqual(['b'])
    expect(lastGroup([cut('a', 'g1'), cut('b', 'g2'), cut('c', 'g2')]).map((s) => s.id)).toEqual(['b', 'c'])
    expect(lastGroup([cut('a', 'g1'), cut('b', 'g1')]).map((s) => s.id)).toEqual(['a', 'b'])
    expect(lastGroup([cut('a', 'g1'), cut('b')]).map((s) => s.id)).toEqual(['b'])
  })
})
