// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tools a local model in the tab gets on each turn. Every turn sends a fixed list of the tools any request can
// need; a status or device read, a G-code utility, printer setup and the other rarely used tools join a turn only when
// the request or the plate calls for their toolset, or once the chat has called them. A tool registered later stays
// out of that list until it is named in it, so it never grows a local model's prompt on every turn. A cloud model is
// not affected.
import type { PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvalEnv } from '../evals/harness'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import type { LlmRequest } from '../src/provider/types'
import { defineTool, type PilotTool } from '../src/tool'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

/** A tool as a new MCP or app feature would register it: a status read of a device. */
const snapshot = defineTool({
  name: 'acme.snapshot',
  version: '1.0.0',
  source: 'command',
  permission: 'read',
  description: 'Read the state of a connected device.',
  input: z.object({}),
  async run() {
    return { summary: 'idle', output: { state: 'idle' } }
  },
}) as PilotTool<never>

async function requests(provider: string, message: string, steps: ScriptStep[] = [{ text: 'ok' }], tools: PilotTool<never>[] = [snapshot]): Promise<{ reqs: LlmRequest[]; offered: string[] }> {
  const client = createScriptedClient(steps, { provider })
  const env = createEvalEnv({ client, machine: MACHINE, objects: [], scope: 'full', tools })
  for await (const _ of env.pilot.run('t', message, { context: { machine: MACHINE } })) void _
  return { reqs: client.requests, offered: env.pilot.tools().map((t) => t.name) }
}
const names = (req: LlmRequest | undefined): string[] => (req?.tools ?? []).map((t) => t.name)

describe('the local full tab', () => {
  it('leaves a newly registered tool out of a local turn that does not call for it, and sends it to a cloud model', async () => {
    const local = await requests('openai-compatible', 'hello')
    // still offered: the model may call it, and the prompt may name it
    expect(local.offered).toContain('acme.snapshot')
    expect(names(local.reqs[0])).not.toContain('acme.snapshot')
    const cloud = await requests('anthropic', 'hello')
    expect(names(cloud.reqs[0])).toContain('acme.snapshot')
    expect(names(cloud.reqs[0])).toEqual(cloud.offered)
  })

  it('keeps status and device reads, G-code utilities and printer setup out of a turn about something else', async () => {
    const sent = names((await requests('openai-compatible', 'hello')).reqs[0])
    for (const n of ['printer.status', 'printer.history', 'moonraker.status', 'moonraker.gcode', 'bambu_lan.gcode', 'printer_setup', 'printer_add', 'schedule', 'resume_from_layer', 'calibrate', 'optimize_to_target', 'compare_setups']) expect(sent).not.toContain(n)
    // the tools any request can need stay
    for (const n of ['kb.search', 'kb.filament', 'web.lookup', 'parts.lookup', 'project.info', 'text_to_part', 'slice', 'arrange', 'settings.apply']) expect(sent).toContain(n)
  })

  it.each([
    { ask: "How's my print going?", joins: ['printer.status', 'printer.history', 'moonraker.status', 'check_print'] },
    { ask: 'Send this G-code to the Voron', joins: ['moonraker.gcode', 'run.target', 'printer.queue'] },
    { ask: 'Set up my new printer', joins: ['printer_setup', 'printer_add', 'printer_test'] },
    { ask: 'Calibrate this PETG spool', joins: ['calibrate'] },
    { ask: 'Schedule these plates on the farm after 6 pm', joins: ['schedule'] },
    { ask: 'Spread these plates across the fleet', joins: ['schedule'] },
    { ask: 'Make this under 2 hours with the best quality settings', joins: ['optimize_to_target', 'compare_setups'] },
    { ask: 'Which material for a part in the sun?', joins: ['material_recommend'] },
  ])('sends the tools "$ask" calls for', async ({ ask, joins }) => {
    const sent = names((await requests('openai-compatible', ask)).reqs[0])
    for (const n of joins) expect(sent).toContain(n)
    expect(sent).not.toContain('acme.snapshot')
  })

  it('runs a tool the turn did not send, and sends it from the next step on and in later turns', async () => {
    const steps: ScriptStep[] = [{ calls: [{ name: 'acme.snapshot', args: {} }] }, { text: 'It is idle.' }, { text: 'ok' }]
    const client = createScriptedClient(steps, { provider: 'openai-compatible' })
    const env = createEvalEnv({ client, machine: MACHINE, objects: [], scope: 'full', tools: [snapshot] })
    const results: { tool?: string; ok?: boolean }[] = []
    for await (const e of env.pilot.run('t', 'hello', { context: { machine: MACHINE } })) if (e.type === 'tool_result') results.push({ ok: e.ok })
    expect(results).toEqual([{ ok: true }])
    expect(names(client.requests[0])).not.toContain('acme.snapshot')
    expect(names(client.requests[1])).toContain('acme.snapshot')
    for await (const _ of env.pilot.run('t', 'thanks', { context: { machine: MACHINE } })) void _
    expect(names(client.requests[2])).toContain('acme.snapshot')
  })

  it('sends a cloud model the same tools whatever it asks', async () => {
    const first = names((await requests('anthropic', 'hello')).reqs[0])
    for (const ask of ["How's my print going?", 'Set up my new printer', 'A 30 mm cube']) expect(names((await requests('anthropic', ask)).reqs[0])).toEqual(first)
  })
})
