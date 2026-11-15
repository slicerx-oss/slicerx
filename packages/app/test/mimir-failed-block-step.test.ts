// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scripted "failed block step" (a build for the end-to-end tests only) starts a block, then sends the fillet step
// with no edges and no radius. The runtime turns the call down on its arguments, in words with the field keys. The
// person reads that step in plain words (the event's summary, with a title and the text in its details), and the model's
// message still carries the full text with its issues.
import type { PilotEvent } from '@slicerx/contracts'
import { tabToolset } from '@slicerx/mcp/toolset'
import { type LlmMessage, plainEngine, plainReason, showsInternalNames } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { standingPlan, withPlanState } from '../src/workspaces/mimir/plan-state'
import { cardPlans } from '../src/workspaces/mimir/plan-tool'
import { scriptedMimir } from '../src/workspaces/mimir/scripted'
import { SCRIPTS } from '../src/workspaces/mimir/scripts'

const loader = { loadParts: async (name: string) => ({ id: name, hash: name, name, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }) } as never

describe('the scripted failed block step', () => {
  it('ends in a failed fillet step that reads in plain words, while the model still gets the full text', async () => {
    const tools = withPlanState(tabToolset(appDesignHost(loader), cardPlans, { nozzleMm: () => 0.4 }))
    // the same script, with a look at what the model is sent after the failed step
    let sent = ''
    const scripts = SCRIPTS.map((s) => (s.id === 'failed-block-step' ? { ...s, steps: [s.steps[0]!, s.steps[1]!, (m: LlmMessage[]) => ((sent = m.at(-1)?.content ?? ''), s.steps[2]!)] } : s)) as typeof SCRIPTS
    const p = scriptedMimir(scripts, tools, { standingPlan })
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'Run a failed block step')) events.push(e)
    expect(events.flatMap((e) => (e.type === 'tool_call' ? [e.tool] : []))).toEqual(['design.new', 'geom.fillet'])
    const results = events.flatMap((e) => (e.type === 'tool_result' ? [e] : []))
    expect(results.map((r) => r.ok)).toEqual([true, false])
    const failed = results[1]!
    // the person's line: plain words, no field key, tool name or command line, with the full text only in the details
    expect(showsInternalNames(failed.summary)).toBe(false)
    expect(failed.summary).toBe(plainEngine(failed.detail ?? '')?.shown)
    expect(failed.title).toBe(plainEngine(failed.detail ?? '')?.title)
    expect(failed.detail).toMatch(/^Invalid arguments: edges: .*radius_mm: /)
    expect(plainReason(failed.summary)).toBe(failed.summary)
    // the model's message is unchanged: the error and every issue with its field key
    const reply = JSON.parse(sent) as { ok: boolean; error: string; issues: string[] }
    expect(reply).toMatchObject({ ok: false, error: 'Invalid arguments' })
    expect(reply.issues.join('; ')).toMatch(/^edges: .*; radius_mm: /)
    expect(`Invalid arguments: ${reply.issues.join('; ')}`).toBe(failed.detail)
    expect(events.map((e) => (e.type === 'text' ? e.delta : '')).join('')).toContain('That step did not go through, so the block is unchanged.')
  })
})
