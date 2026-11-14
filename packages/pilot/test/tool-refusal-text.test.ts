// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tool's own written refusal of a call (a ToolInputError with code invalid_input) reaches the model up to
// REFUSAL_TEXT characters, so a sentence that names the fix is never cut in half. The person's step row shows what it
// showed before: the short text, or the plain catch-all with the short text in its details. Every other error keeps
// errorText's 300 characters. The two refusals are design.plan's own, sent again from a recorded plan of a ship whose
// tiers were keyed by a group name.
import { readFileSync } from 'node:fs'
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_CONFIG } from '../src/config'
import { plainEngine } from '../src/engine-words'
import { errorText } from '../src/provider/client'
import { createScriptedClient } from '../src/provider/scripted'
import { createPilot, REFUSAL_TEXT } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'

const REFUSALS = JSON.parse(readFileSync(new URL('./fixtures/plan-refusals.json', import.meta.url), 'utf8')) as { features: string; groupKey: string }

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const CONFIG = { ...DEFAULT_CONFIG, provider: 'anthropic', model: 'claude-haiku-5-5', billing: 'key' as const, webSearch: false }

/** The MCP tools' refusal of a call's input, as packages/mcp/src/errors.ts throws it. */
class ToolInputError extends Error {
  override readonly name = 'ToolInputError'
  readonly code = 'invalid_input'
}

/** A design.plan that refuses every plan with `error`. */
const refusing = (error: () => Error) =>
  defineTool({
    name: 'design.plan',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'design.plan for the test',
    input: z.object({}),
    async run() {
      throw error()
    },
  }) as PilotTool<never>

/** One call to the refusing tool: the row the person sees, and the text the model reads back. */
async function once(error: () => Error): Promise<{ row: Extract<PilotEvent, { type: 'tool_result' }>; model: string }> {
  const client = createScriptedClient([{ calls: [{ name: 'design.plan', args: {} }] }, { text: 'Fixed the plan.' }], { chunk: false })
  const pilot = createPilot({ host, config: CONFIG, policy: DEFAULT_POLICY, client, builtins: false, tools: [refusing(error)] })
  const events: PilotEvent[] = []
  for await (const e of pilot.run('s', 'plan the ship')) events.push(e)
  const row = events.find((e) => e.type === 'tool_result') as Extract<PilotEvent, { type: 'tool_result' }>
  const sent = client.requests.at(-1)!.messages.find((m) => m.role === 'tool')
  const body = JSON.parse(String(sent?.content)) as { ok: boolean; summary: string }
  expect(body.ok).toBe(false)
  return { row, model: body.summary }
}

/** The tiers sentence of the group-key refusal, whole, as design.plan writes it for this plan. */
const GROUP_SENTENCE = 'tiers: Superstructure is not a planned feature but a name over Promenade deck and Boat deck. If they are levels of one body, key them by the lowest, the body flat lists: tiers: {"Promenade deck":["Promenade deck","Boat deck"]}, with only Promenade deck in flat. If they are separate bodies, give each its own list.'

describe('a tool\'s own refusal reaches the model whole up to its limit', () => {
  it('is 1500 characters, five times the 300 every other error keeps', () => {
    expect(REFUSAL_TEXT).toBe(1500)
    expect(errorText(new Error('x'.repeat(2000)))).toHaveLength(300)
    expect(errorText(new Error('x'.repeat(2000)), REFUSAL_TEXT)).toHaveLength(1500)
  })

  it('gives the model the group-key sentence whole, where the 300 cut stopped at "If"; the row shows the catch-all and the short text as before', async () => {
    const { row, model } = await once(() => new ToolInputError(REFUSALS.groupKey))
    expect(REFUSALS.groupKey.slice(0, 300).endsWith('with only Promenade deck in flat. If')).toBe(true)
    expect(model).toContain(GROUP_SENTENCE)
    // the refusal, cut at 1500, then the retry hint the catch-all adds
    expect(model).toBe(`${REFUSALS.groupKey.slice(0, 1500).replace(/[.\s]+$/, '')}. ${plainEngine(REFUSALS.groupKey.slice(0, 300), 'design.plan')!.hint}`)
    // the person's row, as it read with the 300 cut
    expect(row).toMatchObject({ ok: false, title: 'Step not made', summary: 'That step could not be made, so the part is unchanged. Try asking for it another way.', detail: REFUSALS.groupKey.slice(0, 300) })
  })

  it('keeps the row of a refusal the catch-all does not take at the short text, and gives the model all its problem sentences', async () => {
    const { row, model } = await once(() => new ToolInputError(REFUSALS.features))
    expect(model).toBe(REFUSALS.features.slice(0, 1500))
    expect(model).toContain('this one has 8. Add the real thing\'s parts you left out')
    expect(model).toContain(GROUP_SENTENCE)
    expect(row.summary).toBe(REFUSALS.features.slice(0, 300))
    expect(row.title).toBeUndefined()
    expect(row.detail).toBeUndefined()
  })

  it('cuts any other error at 300 for the model too: one that only carries the code, and a tool\'s other failures', async () => {
    const coded = await once(() => Object.assign(new Error(REFUSALS.features), { code: 'invalid_input' }))
    expect(coded.model).toBe(REFUSALS.features.slice(0, 300))
    const other = await once(() => Object.assign(new ToolInputError(REFUSALS.features), { code: 'busy' }))
    expect(other.model).toBe(REFUSALS.features.slice(0, 300))
    const plain = await once(() => new Error(REFUSALS.features))
    expect(plain.model).toBe(REFUSALS.features.slice(0, 300))
  })

  it('hides a key before the cut, so a long refusal never carries one', async () => {
    const key = `sk-ant-${'a'.repeat(40)}`
    const { model, row } = await once(() => new ToolInputError(`${'x'.repeat(1000)} ${key} ${'y'.repeat(1000)}`))
    expect(model).not.toContain(key)
    expect(model).toContain('sk-...')
    expect(row.summary).not.toContain(key)
  })
})
