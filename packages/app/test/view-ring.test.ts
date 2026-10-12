// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's ring menu: what it is for after a right click, its verbs for each target, Delete never on a ring, and every
// verb naming the MCP tool an agent uses for the same, or the cad-mcp gap that has none yet.
import { describe, expect, it } from 'vitest'
import { ringTarget } from '../src/plate/view-ring'
import { RING_VERBS } from '../src/workspaces/design/view-ring'

const face = (triangle: number) => ({ kind: 'face' as const, objectId: 'o1', partIndex: 0, triangle, point: [0, 0, 0] as [number, number, number] })

describe('the view ring', () => {
  it('is for the picked faces or edges first, then the selected object, else empty space', () => {
    expect(ringTarget({ subPicks: [face(1), face(4)], selection: 'o1' })).toEqual({ kind: 'face', objectId: 'o1', count: 2 })
    expect(ringTarget({ subPicks: [], selection: 'o1' })).toEqual({ kind: 'object', objectId: 'o1' })
    expect(ringTarget({ subPicks: [], selection: null })).toEqual({ kind: 'empty' })
  })

  it('has at most six verbs per target and keeps Delete off every ring', () => {
    for (const [kind, verbs] of Object.entries(RING_VERBS)) {
      expect(verbs.length, kind).toBeLessThanOrEqual(6)
      expect(verbs.some((v) => /delete|remove/i.test(v.id + v.label)), kind).toBe(false)
    }
  })

  it('names the MCP tool or the cad-mcp gap for every verb', () => {
    for (const verbs of Object.values(RING_VERBS)) for (const v of verbs) expect(v.agent, v.id).toMatch(/^(slicerx_[a-z_]+|gap [246]: .+|view)$/)
  })
})
