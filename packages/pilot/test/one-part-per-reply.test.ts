// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A reply fixes the part it started instead of starting it again: a second design.new in the same run that restarts that
// part is refused with the design already started, how to fix it there and how to add a separate part. A separate part
// the message or its approved plan names (a box and a lid as separate designs, the parts of an assembly) starts its own
// design. The next message starts its own part as before.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, type LlmMessage, type ScriptStep } from '../src/index'
import { ONE_PART_NOTE } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

function designNew(made: string[]): PilotTool<never> {
  return defineTool({
    name: 'design.new',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({ name: z.string() }),
    async run(i) {
      const id = `obj_${made.length + 1}`
      made.push(i.name)
      return { summary: `Started ${i.name} (${id})`, output: { design: id, name: i.name } }
    },
  }) as PilotTool<never>
}

const NEW = (name: string) => ({ calls: [{ name: 'design.new', args: { name } }] })

/** design.plan answered Go, as the plan card does. */
const plan = defineTool({
  name: 'design.plan',
  version: '1.0.0',
  source: 'command',
  permission: 'read',
  description: 'test',
  input: z.object({ part: z.string(), features: z.array(z.object({ name: z.string() })) }),
  async run() {
    return { summary: 'Approved as shown', output: { planId: 'plan_1', accepted: true } }
  },
}) as PilotTool<never>

async function reply(message: string, steps: ScriptStep[]): Promise<{ made: string[]; seen: string[] }> {
  const made: string[] = []
  const seen: string[] = []
  // each step after a call sees that call's answer last
  const watched = steps.map((s) => (m: LlmMessage[]) => (seen.push(m.at(-1)?.content ?? ''), typeof s === 'function' ? s(m) : s))
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(watched, { chunk: false }), builtins: false, tools: [designNew(made), plan] })
  for await (const _ of p.run('s', message)) void _
  return { made, seen }
}

it('refuses a second design.new in one reply, naming the part to fix, and starts one in the next message', async () => {
  const made: string[] = []
  const seen: string[] = []
  const steps: ScriptStep[] = [NEW('Headphone stand'), NEW('Headphone stand v2'), (m) => (seen.push(m.at(-1)?.content ?? ''), { text: 'Fixing the first one.' }), NEW('Desk clip'), { text: 'Started.' }]
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [designNew(made)] })
  for await (const _ of p.run('s', 'A headphone stand')) void _
  expect(made).toEqual(['Headphone stand'])
  expect(seen[0]).toContain(ONE_PART_NOTE('Headphone stand', 'obj_1'))
  expect(seen[0]).toMatch(/design\.undo takes back the last step/)
  expect(seen[0]).toMatch(/To add a separate part that the message or its plan names, start it with design\.new under that part's own name\./)
  for await (const _ of p.run('s', 'Now a desk clip')) void _
  expect(made).toEqual(['Headphone stand', 'Desk clip'])
})

it('starts a separate part the message names in its own design', async () => {
  const { made } = await reply('A box and a lid as separate designs', [NEW('Box'), NEW('Lid'), { text: 'Both started.' }])
  expect(made).toEqual(['Box', 'Lid'])
})

it('starts each part of an assembly the message names', async () => {
  const { made } = await reply('A small gearbox assembly: a housing, a drive gear and a cover', [NEW('Gearbox housing'), NEW('Drive gear'), NEW('Cover'), { text: 'All three started.' }])
  expect(made).toEqual(['Gearbox housing', 'Drive gear', 'Cover'])
})

it('starts a separate part the approved plan names', async () => {
  const go = { calls: [{ name: 'design.plan', args: { part: 'Pi 5 case', features: [{ name: 'Base with standoffs' }, { name: 'Snap-fit lid' }] } }] }
  const { made } = await reply('A Raspberry Pi 5 case', [go, NEW('Pi 5 case base'), NEW('Snap-fit lid'), { text: 'Both started.' }])
  expect(made).toEqual(['Pi 5 case base', 'Snap-fit lid'])
})

it('refuses a restart of the same part even when the message names separate parts', async () => {
  const { made, seen } = await reply('A box and a lid as separate designs', [NEW('Box'), NEW('Box v2'), { text: 'Fixing the box.' }])
  expect(made).toEqual(['Box'])
  expect(seen[2]).toContain(ONE_PART_NOTE('Box', 'obj_1'))
})

it('names the part a restart repeats when the reply has started two', async () => {
  const { made, seen } = await reply('A box and a lid as separate designs', [NEW('Box'), NEW('Lid'), NEW('Lid v2'), { text: 'Fixing the lid.' }])
  expect(made).toEqual(['Box', 'Lid'])
  expect(seen[3]).toContain(ONE_PART_NOTE('Lid', 'obj_2'))
})

it('refuses a restart under a new name the message never asked for', async () => {
  const { made, seen } = await reply('A headphone stand', [NEW('Headphone stand'), NEW('Sturdier headphone stand'), { text: 'Fixing the stand.' }])
  expect(made).toEqual(['Headphone stand'])
  expect(seen[2]).toContain(ONE_PART_NOTE('Headphone stand', 'obj_1'))
})
