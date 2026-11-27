// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a build eval session's tokens and dollars go on mimir cloud, measured from its recording with no model call:
// each recorded case replays through the tab as the desktop makes it, with the replay run as mimir cloud's client (tool
// search on, the proxy's tool limit), and every request is counted (packages/mcp/evals/creative/cost.ts). Off unless
// asked, and it needs the geometry engine, as the build eval replays do:
//   SX_MIMIR_COST=out.json [SX_SLOW_EVALS=1] vitest run test/mimir-build-cost.test.ts
// prints a table per session and writes every request's count to out.json. The creative recordings have the same count
// in the creative eval's replay (pnpm --filter @slicerx/mcp eval:creative --cost out.json).
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { costClient, costTable, recordedUsage, sessionCost, type CallCost, type SessionCost } from '../../mcp/evals/creative/cost'
import { setGeomProvider } from '../src/geom/client'
import { liveEngine, wasmGeom } from './geom-engine'
import { BUILD_CASES } from './mimir-build-evals/cases'
import { driveCase, NUDGES } from './mimir-build-evals/drive'
import { loadRecording } from './mimir-build-evals/recordings'

const out = process.env['SX_MIMIR_COST']
/** As the build eval replays: the lofted vases are slow to rebuild, and a paused case no longer replays (mimir-build-evals.test.ts PAUSED_REPLAYS). */
const SLOW = new Set(['twisted-vase', 'flared-vase'])
const PAUSED = new Set<string>([])

describe.runIf(out !== undefined && liveEngine)('tokens and dollars of each recorded build eval session on mimir cloud', () => {
  const costs: { session: SessionCost; calls: CallCost[]; recorded?: ReturnType<typeof recordedUsage> }[] = []
  beforeAll(async () => setGeomProvider(await wasmGeom()))
  afterAll(() => {
    setGeomProvider(null)
    process.stdout.write(`\n${costTable(costs.map((c) => c.session))}\n`)
    if (out) writeFileSync(out, `${JSON.stringify(costs, null, 1)}\n`)
  })
  for (const c of BUILD_CASES) {
    const rec = loadRecording(c.id)
    it.skipIf(!rec || PAUSED.has(c.id) || (SLOW.has(c.id) && process.env['SX_SLOW_EVALS'] !== '1'))(c.id, { timeout: 180_000 }, async () => {
      const calls: CallCost[] = []
      const people = new Set([c.prompt, ...Object.values(NUDGES)])
      // a capture on which mimir cloud moved to another model names each one, joined by '+' (hinged-box), and the chat
      // was configured for the first; as the joined name the model would take no tool search and load every tool
      const model = rec!.model.split('+')[0]
      await driveCase(c, { steps: rec!.steps, ...(model ? { model } : {}), timeoutMs: 170_000, midBuildAnswer: rec!.midBuildAnswer === true, wrap: (inner) => costClient(inner, calls, people) })
      // a live capture since recordings kept usage also has the provider's own counts, thinking included
      const recorded = recordedUsage(rec!.steps)
      costs.push({ session: sessionCost(c.id, calls, rec!), calls, ...(recorded ? { recorded } : {}) })
    })
  }
})
