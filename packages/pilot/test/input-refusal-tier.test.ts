// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto moves a run from huginn to muninn when huginn struggles: two failed tool results, or a design check that missed
// its plan. A tool turning a call down for its own input (arguments out of shape, a sheet row with no place on the
// drawing, an MCP tool's invalid_input) is the model's slip, fixed by sending the call again, so it counts apart: a
// first dimension sheet sent back twice keeps the run on huginn, and a third refusal still moves it up. A call to a tool
// that does not exist still counts as a failure.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PilotSheet, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_CONFIG } from '../src/config'
import { INPUT_REFUSAL_FAILS, STRUGGLE_FAILS } from '../src/models'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import { createPilot } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'
import { sheetTool } from '../src/index'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const AUTO = { ...DEFAULT_CONFIG, provider: 'anthropic', model: 'claude-haiku-5-5', models: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' }, billing: 'key' as const, auto: true, webSearch: false }

/** A tool named design.new, which makes the runtime build with the design tools (the mimir tab). */
const DESIGN_NEW = defineTool({ name: 'design.new', version: '1.0.0', source: 'command', permission: 'read', description: 'design.new for the test', input: z.object({}), async run() { return { summary: 'ok' } } }) as PilotTool<never>
/** A lookup that finds nothing: a real failure, not a refusal of its input. */
const MISSING = defineTool({ name: 'parts.lookup', version: '1.0.0', source: 'command', permission: 'read', description: 'parts.lookup for the test', input: z.object({ name: z.string() }), async run(i) { return { ok: false, summary: `"${i.name}" is not in the standard parts table` } } }) as PilotTool<never>
/** An MCP tool that throws its refusal of the input, as ToolInputError does (code invalid_input), or another code. Not a design tool, whose failures never count (building takes tries). */
const throwing = (code: string) =>
  defineTool({
    name: 'project.info',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'project.info for the test',
    input: z.object({}),
    async run() {
      throw Object.assign(new Error('object: there is no object o9 on the plate'), { code })
    },
  }) as PilotTool<never>

const at = { a: [0, 0, 0], b: [240, 0, 0], off: [0, -10, 0] }
const PART = [{ plane: 'xy', points: [[0, 0], [240, 0], [240, 26], [0, 26]], from: 0, to: 16 }]
const DIMS = [
  { key: 'hull_length', label: 'Hull length', value: 240, unit: 'mm', source: 'guess', at },
  { key: 'hull_beam', label: 'Hull beam', value: 26, unit: 'mm', source: 'guess', at: { a: [0, 0, 0], b: [0, 26, 0], off: [-10, 0, 0] } },
]
/** The sheet as a model's first tries can send it: part as a string (out of shape), then a row with no place. */
const PART_AS_TEXT = { name: 'pilot.sheet', args: { title: 'Toy boat', dims: DIMS, part: 'hull' } }
const NO_PLACE = { name: 'pilot.sheet', args: { title: 'Toy boat', dims: [DIMS[0], { ...DIMS[1], at: undefined }], part: PART } }
const GOOD = { name: 'pilot.sheet', args: { title: 'Toy boat', dims: DIMS, part: PART } }

async function run(steps: ScriptStep[], tools: PilotTool<never>[] = []): Promise<{ models: string[]; switches: string[]; events: PilotEvent[] }> {
  const client = createScriptedClient(steps, { chunk: false })
  const pilot = createPilot({ host, config: AUTO, policy: DEFAULT_POLICY, client, builtins: false, tools: [DESIGN_NEW, sheetTool(), ...tools] })
  const events: PilotEvent[] = []
  for await (const e of pilot.run('s', 'design a small toy boat and paint it')) {
    events.push(e)
    if (e.type === 'sheet') void pilot.answerSheet!((e as { sheet: PilotSheet }).sheet.id, {})
  }
  return { models: client.requests.filter((r) => !r.webSearch).map((r) => r.model), switches: events.filter((e) => e.type === 'model_switch').map((e) => (e as { reason: string }).reason), events }
}

const haiku = (n: number) => Array.from({ length: n }, () => 'claude-haiku-5-5')

describe('a refusal of a call\'s own input on Auto', () => {
  it('counts apart from other failures, with a higher bar', () => {
    expect(INPUT_REFUSAL_FAILS).toBeGreaterThan(STRUGGLE_FAILS)
  })

  it('keeps the run on huginn when the first sheet is sent back twice, then shown', async () => {
    const r = await run([{ calls: [PART_AS_TEXT] }, { calls: [NO_PLACE] }, { calls: [GOOD] }, { text: 'Sizes confirmed; planning it next.' }])
    // both refusals reached the model, and the third sheet was shown
    const results = r.events.filter((e) => e.type === 'tool_result') as { ok: boolean; summary: string }[]
    expect(results.map((x) => x.ok)).toEqual([false, false, true])
    expect(results[0]!.summary).toContain('Invalid arguments: part')
    expect(results[1]!.summary).toContain('every row needs at')
    expect(r.events.some((e) => e.type === 'sheet')).toBe(true)
    expect(r.models).toEqual(haiku(4))
    expect(r.switches).toEqual([])
  })

  it('still moves up on the third refusal in a run', async () => {
    const r = await run([{ calls: [PART_AS_TEXT] }, { calls: [NO_PLACE] }, { calls: [PART_AS_TEXT] }, { calls: [GOOD] }, { text: 'Sizes confirmed.' }])
    expect(r.models).toEqual([...haiku(3), 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect(r.switches).toEqual(['struggle'])
  })

  it('takes arguments that are not JSON as a refusal of the input, and a tool that does not exist as a failure', async () => {
    const json = await run([{ calls: [{ name: 'pilot.sheet', args: '{"title": "Toy boat", ' as unknown as Record<string, unknown> }] }, { calls: [{ name: 'pilot.sheet', args: '{"title": ' as unknown as Record<string, unknown> }] }, { text: 'Trying again.' }])
    expect(json.models).toEqual(haiku(3))
    expect(json.switches).toEqual([])
    const unknown = await run([{ calls: [{ name: 'pilot.sheets', args: {} }] }, { calls: [{ name: 'pilot.sheets', args: {} }] }, { text: 'Done.' }])
    expect(unknown.models).toEqual([...haiku(2), 'claude-sonnet-5-5'])
    expect(unknown.switches).toEqual(['struggle'])
  })

  it('takes an MCP tool\'s thrown invalid_input as a refusal, and any other thrown code as a failure', async () => {
    const refused = await run([{ calls: [{ name: 'project.info', args: {} }] }, { calls: [{ name: 'project.info', args: {} }] }, { text: 'No such object.' }], [throwing('invalid_input')])
    expect(refused.models).toEqual(haiku(3))
    expect(refused.switches).toEqual([])
    const failed = await run([{ calls: [{ name: 'project.info', args: {} }] }, { calls: [{ name: 'project.info', args: {} }] }, { text: 'It broke.' }], [throwing('internal_error')])
    expect(failed.models).toEqual([...haiku(2), 'claude-sonnet-5-5'])
    expect(failed.switches).toEqual(['struggle'])
  })

  it('still moves up after two real failures, and a refusal does not add to them', async () => {
    // a lookup miss and a sheet refusal: one failure and one refusal stay on huginn
    const mixed = await run([{ calls: [{ name: 'parts.lookup', args: { name: 'Desk organizer' } }] }, { calls: [PART_AS_TEXT] }, { calls: [GOOD] }, { text: 'Sizes confirmed.' }], [MISSING])
    expect(mixed.models).toEqual(haiku(4))
    expect(mixed.switches).toEqual([])
    const two = await run([{ calls: [{ name: 'parts.lookup', args: { name: 'Desk organizer' } }] }, { calls: [{ name: 'parts.lookup', args: { name: 'Toy boat' } }] }, { text: 'Not in the table.' }], [MISSING])
    expect(two.models).toEqual([...haiku(2), 'claude-sonnet-5-5'])
    expect(two.switches).toEqual(['struggle'])
  })
})
