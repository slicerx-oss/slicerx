// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Calls local models got wrong in the benchmark that are fixed on our side: null for a field left
// out, printer_setup given printer_test's connection object, and make_model holes given x, y, z.
import type { PilotEvent, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvalEnv } from '../evals/harness'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import { defineTool, type PilotTool } from '../src/tool'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

async function results(steps: ScriptStep[], tools: PilotTool<never>[] = []) {
  const env = createEvalEnv({ client: createScriptedClient([...steps, { text: 'done' }]), machine: MACHINE, objects: [], tools })
  const out: Extract<PilotEvent, { type: 'tool_result' }>[] = []
  for await (const ev of env.pilot.run('t', 'go', { context: { machine: MACHINE } })) {
    if (ev.type === 'approval_request') await env.pilot.resolveApproval(ev.request.id, { kind: 'approve' })
    if (ev.type === 'tool_result') out.push(ev)
  }
  return out
}

describe('arguments local models get wrong', () => {
  it('leaves out a null the schema does not allow, and keeps a null it does', async () => {
    const seen: unknown[] = []
    const echo = (name: string, input: z.ZodType) =>
      defineTool({
        name,
        version: '1.0.0',
        source: 'plugin',
        permission: 'read',
        description: 'test',
        input: input as z.ZodObject,
        async run(i) {
          seen.push(i)
          return { summary: 'ok' }
        },
      }) as PilotTool<never>
    const strict = echo('test.strict', z.object({ name: z.string(), note: z.string().optional(), opts: z.object({ user: z.string().optional() }).optional() }))
    const nullable = echo('test.nullable', z.object({ name: z.string(), note: z.string().nullable() }))
    const out = await results(
      [{ calls: [{ name: 'test.strict', args: { name: 'a', note: null, opts: { user: null } } }] }, { calls: [{ name: 'test.nullable', args: { name: 'b', note: null } }] }, { calls: [{ name: 'test.strict', args: { name: null } }] }],
      [strict, nullable],
    )
    expect(out.map((r) => r.ok)).toEqual([true, true, false])
    expect(seen).toEqual([{ name: 'a', opts: {} }, { name: 'b', note: null }])
    expect(out[2]?.summary).toMatch(/^Invalid arguments: name/)
  })

  it('printer_setup takes the connection object printer_test takes', async () => {
    const out = await results([{ calls: [{ name: 'printer_setup', args: { brand: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4, skipLook: true, connection: { family: 'bambu-lan', address: '192.168.1.40', serial: '01P00A123456789' } } }] }])
    expect(out[0]?.ok).toBe(true)
    expect(out[0]?.summary).not.toMatch(/Invalid arguments/)
    // The object gave the method, address and serial, so setup moves on to testing the connection.
    expect(out[0]?.summary).toBe('Setup stage: test, Bambu Lab P1S')
  })

  it('make_model takes a hole at x, y, z and ignores z', async () => {
    const out = await results([{ calls: [{ name: 'make_model', args: { name: 'Tag', parts: [{ kind: 'box', color: 'black', sizeMm: [40, 20, 2] }], holes: [{ part: 0, diameterMm: 4, atMm: [-14, 0, 1] }] } }] }])
    expect(out[0]?.summary ?? '').not.toMatch(/Invalid arguments/)
  })
})
