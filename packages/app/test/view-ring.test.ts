// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's ring menu: what it is for after a right click, its verbs for each target, Delete never on a ring, and every
// verb naming an MCP tool the server has (packages/mcp/TOOLS.md), for an agent to do the same.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ringTarget } from '../src/plate/view-ring'
import { MORE_AGENT_TOOLS, RING_VERBS } from '../src/workspaces/design/view-ring'

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

  it('names an MCP tool the server has for every verb, other than a change of view', () => {
    const tools = new Set(readFileSync(join(__dirname, '..', '..', 'mcp', 'TOOLS.md'), 'utf8').match(/`slicerx_[a-z_]+`/g)?.map((t) => t.slice(1, -1)))
    for (const verbs of Object.values(RING_VERBS))
      for (const v of verbs) {
        expect(v.agent, v.id).toMatch(/^(slicerx_[a-z_]+|view)$/)
        if (v.agent !== 'view') expect(tools.has(v.agent), `${v.id}: ${v.agent}`).toBe(true)
      }
    // and for every verb under More that is not on a ring
    for (const [id, tool] of Object.entries(MORE_AGENT_TOOLS)) expect(tools.has(tool), `${id}: ${tool}`).toBe(true)
  })
})
