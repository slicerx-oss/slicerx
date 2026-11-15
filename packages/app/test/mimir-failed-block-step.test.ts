// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scripted "failed block step" (a build for the end-to-end tests only) starts a block, then sends the fillet step
// with no edges and no radius. The real tool turns it down on its arguments, in its own words with the field keys, and
// the engine's plain-words pass does not see that text (it covers an engine refusal, not an argument check), so the
// step's summary stays as written. The working loop's list shows the catch-all sentence for it (plainReason).
import type { PilotEvent } from '@slicerx/contracts'
import { tabToolset } from '@slicerx/mcp/toolset'
import { plainReason, STEP_NOT_MADE } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { standingPlan, withPlanState } from '../src/workspaces/mimir/plan-state'
import { cardPlans } from '../src/workspaces/mimir/plan-tool'
import { scriptedMimir } from '../src/workspaces/mimir/scripted'
import { SCRIPTS } from '../src/workspaces/mimir/scripts'

const loader = { loadParts: async (name: string) => ({ id: name, hash: name, name, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }) } as never

describe('the scripted failed block step', () => {
  it('ends in a failed fillet step whose summary carries field keys, and reads as the catch-all sentence', async () => {
    const tools = withPlanState(tabToolset(appDesignHost(loader), cardPlans, { nozzleMm: () => 0.4 }))
    const p = scriptedMimir(SCRIPTS, tools, { standingPlan })
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'Run a failed block step')) events.push(e)
    expect(events.flatMap((e) => (e.type === 'tool_call' ? [e.tool] : []))).toEqual(['design.new', 'geom.fillet'])
    const results = events.flatMap((e) => (e.type === 'tool_result' ? [e] : []))
    expect(results.map((r) => r.ok)).toEqual([true, false])
    const failed = results[1]!
    expect(failed.summary).toMatch(/^Invalid arguments: edges: .*radius_mm: /)
    // no plain title or details came with it: the summary is all the list has
    expect(failed.title).toBeUndefined()
    expect(failed.detail).toBeUndefined()
    expect(plainReason(failed.summary)).toBe(STEP_NOT_MADE)
    expect(events.map((e) => (e.type === 'text' ? e.delta : '')).join('')).toContain('That step did not go through, so the block is unchanged.')
  })
})
