// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An MCP client's plan over the app link (design.plan): kept in the registry the app's design.check reads, beside the
// mimir tab's plans, with no card; a plan off the shared schema is refused and nothing is kept.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, runCall, useDesignHost, type LinkError } from '../src/app-link/methods'
import { mimirPlans } from '../src/workspaces/mimir/plans'

const handle = (name: string): MeshHandle => ({ id: name, hash: name, name, triangles: 12, bboxMm: [20, 10, 3], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
beforeAll(() => useDesignHost(loader))
afterEach(() => mimirPlans.clear())

const plan = { planId: 'client-1', part: 'Spacer', units: 'mm', features: [{ name: 'body', kind: 'extrude', sizes: { width: 40, depth: 20, height: 5 } }], overall: { x: 40, y: 20, z: 5 }, assumptions: [], questions: [] }

describe('design.plan over the app link', () => {
  it('reads with the read class', () => {
    expect(APP_LINK_METHODS['design.plan']).toBe('read')
  })

  it("keeps a client's plan where the app's design.check reads it", async () => {
    const out = (await runCall('design.plan', { plan })) as { summary: string; output: { planId: string } }
    expect(out.output.planId).toBe('client-1')
    expect(mimirPlans.get('client-1')).toEqual({ plan })
    // design.check now finds it (no design open, so it says what to build)
    const e = await runCall('design.check', { planId: 'client-1' }).then(() => null, (x: unknown) => x as LinkError)
    expect(e?.message).toContain('build Spacer first')
  })

  it('refuses a plan off the schema and keeps nothing', async () => {
    const e = await runCall('design.plan', { plan: { ...plan, overall: { x: -1, y: 20, z: 5 } } }).then(() => null, (x: unknown) => x as LinkError)
    expect(e?.code).toBe('invalid_input')
    expect(mimirPlans.get('client-1')).toBeUndefined()
  })
})
