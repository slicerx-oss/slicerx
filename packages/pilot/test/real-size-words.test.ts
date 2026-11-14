// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a real-size lookup reads from the runtime: the person's own words in the chat (ToolContext.said), for a size
// they stated, and a web search that asks for sizes one per line (WEB_SIZES_LINE) in place of the short reply a 3D
// printing question gets.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_CONFIG } from '../src/config'
import { createScriptedClient } from '../src/provider/scripted'
import { createPilot, WEB_SIZES_LINE } from '../src/runtime'
import { defineTool, type PilotTool, type ToolContext } from '../src/tool'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const CONFIG = { ...DEFAULT_CONFIG, provider: 'anthropic', model: 'claude-haiku-5-5', models: { huginn: 'claude-haiku-5-5', muninn: 'claude-haiku-5-5' }, billing: 'key' as const }

/** A tool that keeps what it read: the person's words and a sizes search. */
function reader() {
  const seen: { said: readonly string[]; answer: string }[] = []
  const tool = defineTool({
    name: 'design.read_words',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'reads the words for the test',
    input: z.object({}),
    async run(_i, ctx: ToolContext) {
      const res = await ctx.web!('a suspension bridge: Tower height', ctx.signal, 'sizes')
      seen.push({ said: ctx.said?.() ?? [], answer: res.text })
      return { summary: 'read' }
    },
  }) as PilotTool<never>
  return { tool, seen }
}

describe('what a real-size lookup reads from the runtime', () => {
  it("gives a tool the person's requests in the chat, and asks the web for sizes one per line", async () => {
    const { tool, seen } = reader()
    const client = createScriptedClient([{ calls: [{ name: 'design.read_words', args: {} }] }, { text: 'Done.' }, { calls: [{ name: 'design.read_words', args: {} }] }, { text: 'Done.' }], { chunk: false })
    const pilot = createPilot({ host, config: CONFIG, policy: DEFAULT_POLICY, client, builtins: false, tools: [tool] })
    for await (const _ of pilot.run('s', 'Make me the bridge near us: its towers are 227 m tall')) void _
    for await (const _ of pilot.run('s', 'and the deck is 280 m long')) void _
    expect(seen.map((s) => s.said)).toEqual([['Make me the bridge near us: its towers are 227 m tall'], ['Make me the bridge near us: its towers are 227 m tall', 'and the deck is 280 m long']])
    const web = client.requests.filter((r) => r.webSearch)
    expect(web.length).toBe(2)
    expect(web[0]!.messages[0]).toEqual({ role: 'system', content: WEB_SIZES_LINE })
    // each line starts with the size's own name, and the answer is not spent on thinking
    expect(WEB_SIZES_LINE).toContain("starting with that size's name exactly as asked")
    expect(WEB_SIZES_LINE.startsWith('Find the real sizes asked for, using web search. ')).toBe(true)
    // its example figure is a neutral one, not a real thing's size
    expect(WEB_SIZES_LINE).toContain('such as "Overall length: 42.5 m"')
    expect(web.every((r) => r.thinking === false)).toBe(true)
    expect(web[0]!.messages[1]).toEqual({ role: 'user', content: 'a suspension bridge: Tower height' })
  })
})
