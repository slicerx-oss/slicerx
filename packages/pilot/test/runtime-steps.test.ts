// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A multi-step request in the mimir tab: the model's numbered step list reaches the person as an ordinary assistant
// message, ahead of the first tool call, and the system prompt it ran under asks for that list.
import type { PilotEvent, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { createScriptedClient } from '../src/provider/scripted'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

const STEPS = ['1. Check your printer and the loaded spool.', '2. Slice the plate with the PLA profile.', '3. Queue the print. This needs your OK.', '4. Start the print. This needs your OK.'].join('\n')

describe('a step list before a multi-step task', () => {
  it('"set up my printer and slice this" says numbered steps, with needs your OK on queue and start, before the first tool call', async () => {
    const client = createScriptedClient(
      [
        { text: STEPS, calls: [{ name: 'printer.status', args: {} }] },
        { text: 'Your printer is ready. I started with step 1; the slice and the queue come next.' },
      ],
      { provider: 'anthropic' },
    )
    const env = createEvalEnv({ client, machine: MACHINE, objects: [] })
    const events: PilotEvent[] = []
    for await (const ev of env.pilot.run('s', 'set up my printer and slice this', { context: { machine: MACHINE } })) events.push(ev)

    const firstCall = events.findIndex((e) => e.type === 'tool_call')
    expect(firstCall).toBeGreaterThan(-1)
    const before = events.slice(0, firstCall).flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
    const lines = before.split('\n')
    expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(4)
    expect(lines.find((l) => /Queue/.test(l))).toContain('needs your OK')
    expect(lines.find((l) => /Start/.test(l))).toContain('needs your OK')
    expect(lines.find((l) => /Slice/.test(l))).not.toContain('needs your OK')

    const system = String(client.requests[0]!.messages[0]!.content)
    expect(system).toContain('Multi-step requests:')
    expect(system.indexOf('Multi-step requests:')).toBeGreaterThan(system.indexOf('Permissions and approvals:'))
  })
})
