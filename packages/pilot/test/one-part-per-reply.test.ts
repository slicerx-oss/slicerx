// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Everything one message asks for is one part, so a reply starts at most one design: a second design.new in the same
// run is refused with the design already started and how to fix it, and nothing else is started beside it. The next
// message starts its own part as before.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, type ScriptStep } from '../src/index'
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

it('refuses a second design.new in one reply, naming the part to fix, and starts one in the next message', async () => {
  const made: string[] = []
  const seen: string[] = []
  const steps: ScriptStep[] = [NEW('Headphone stand'), NEW('Headphone stand v2'), (m) => (seen.push(m.at(-1)?.content ?? ''), { text: 'Fixing the first one.' }), NEW('Desk clip'), { text: 'Started.' }]
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [designNew(made)] })
  for await (const _ of p.run('s', 'A headphone stand')) void _
  expect(made).toEqual(['Headphone stand'])
  expect(seen[0]).toContain(ONE_PART_NOTE('Headphone stand', 'obj_1'))
  expect(seen[0]).toMatch(/design\.undo takes back the last step/)
  for await (const _ of p.run('s', 'Now a desk clip')) void _
  expect(made).toEqual(['Headphone stand', 'Desk clip'])
})
