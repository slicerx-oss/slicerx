// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cloud request sends each tool result from an earlier turn as one line and the turn in progress whole. Every result
// still answers its tool call, signed reasoning from the earlier turns leaves from the oldest end once anything is
// shortened, and the same history folds to the same bytes on every request of a turn, so the cache holds.
import { DEFAULT_POLICY, type LlmTransport } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { firstSentence, FOLD_KEEP_CHARS, FOLD_NOTE, foldedLine, foldEarlierTurns } from '../src/fold'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool } from '../src/index'
import { PLAN_SEED_NOTE } from '../src/plan-left'
import { createAnthropicAdapter } from '../src/provider/anthropic'
import type { LlmMessage } from '../src/provider/types'

type Obj = Record<string, unknown>
const png = { mime: 'image/png' as const, data: 'AAAA' }
const pad = 'x'.repeat(FOLD_KEEP_CHARS)
const big = (summary: string, result: unknown = {}) => JSON.stringify({ ok: true, summary, result: { ...(result as Obj), filler: pad } })
const ask = (words: string): LlmMessage => ({ role: 'user', content: `Today is 2026-11-16.\n\nUser request:\n${words}` })
const call = (id: string, name: string, think?: string): LlmMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, arguments: '{}' }],
  raw: [...(think ? [{ type: 'thinking', thinking: think, signature: `sig-${think}` }] : []), { type: 'tool_use', id, name: name.replace('.', '__'), input: {} }],
  bound: 'k1',
})
const answer = (id: string, content: string, images?: boolean): LlmMessage => ({ role: 'tool', callId: id, content, ...(images ? { images: [png] } : {}) })

/** Turn 1 built and checked a ship; turn 2 is in progress (its request opens at index 6, so runStart is 7). */
function history(): LlmMessage[] {
  return [
    { role: 'system', content: 'sys' },
    ask('make a ship'),
    call('t1', 'geom.extrude', 'a1'),
    answer('t1', big('Joined: step 2, Rectangle extrude 3.6 mm', { design: 'obj_1' })),
    call('t2', 'design.check', 'a2'),
    answer('t2', JSON.stringify({ ok: false, error: 'Invalid arguments', issues: [pad] })),
    ask('rake the funnels back'),
    call('t3', 'design.look'),
    answer('t3', big('Looked at the model', { design: 'obj_1' }), true),
    call('t4', 'design.edit_step', 'b1'),
    answer('t4', big('Edited step 5, Ellipse extrude 15.1 mm: it leans 5 degrees toward -x. The rest stays.', { design: 'obj_1' })),
  ]
}

const thinking = (ms: readonly LlmMessage[]) => ms.flatMap((m) => (m.role === 'assistant' ? (m.raw ?? []).filter((b) => (b as Obj)['type'] === 'thinking').map((b) => (b as Obj)['thinking']) : []))

describe('folding earlier turns', () => {
  it('sends each long result from an earlier turn as one line naming the tool, how it went and its ids', () => {
    const ms = history()
    const out = foldEarlierTurns(ms, 7)
    expect(out[3]).toEqual({ role: 'tool', callId: 't1', content: `geom.extrude, earlier turn (shortened): done: Joined: step 2, Rectangle extrude 3.6 mm. design obj_1. ${FOLD_NOTE}` })
    expect(out[5]).toEqual({ role: 'tool', callId: 't2', content: 'design.check, earlier turn (shortened): failed: Invalid arguments.' })
    for (const m of out) if (m.role === 'tool') expect(m.content).not.toContain('\n')
  })

  it('leaves the turn in progress whole, pictures and reasoning included, as the same objects', () => {
    const ms = history()
    const out = foldEarlierTurns(ms, 7)
    for (let i = 6; i < ms.length; i++) expect(out[i]).toBe(ms[i])
    expect(thinking(out)).toEqual(['b1'])
  })

  it('takes every earlier reasoning block out once something is shortened, and keeps each tool call', () => {
    const out = foldEarlierTurns(history(), 7)
    expect(out[2]).toEqual({ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'geom.extrude', arguments: '{}' }], raw: [{ type: 'tool_use', id: 't1', name: 'geom__extrude', input: {} }] })
    expect(out[2]).not.toHaveProperty('bound')
  })

  it('changes nothing, reasoning included, when every earlier result is short', () => {
    const ms: LlmMessage[] = [{ role: 'system', content: 'sys' }, ask('make a cube'), call('t1', 'design.new', 'a1'), answer('t1', '{"ok":true,"summary":"Started Cube (obj_1)"}'), ask('make it taller')]
    const out = foldEarlierTurns(ms, 5)
    expect(out).toEqual(ms)
    out.forEach((m, i) => expect(m).toBe(ms[i]))
  })

  it('sends a short earlier result as it is, without its picture', () => {
    const ms: LlmMessage[] = [{ role: 'system', content: 'sys' }, ask('make a cube'), call('t1', 'design.look', 'a1'), answer('t1', '{"ok":true,"summary":"Looked at the model"}', true), ask('make it taller')]
    const out = foldEarlierTurns(ms, 5)
    expect(out[3]).toEqual({ role: 'tool', callId: 't1', content: '{"ok":true,"summary":"Looked at the model"}' })
    // a picture leaving is a change, so the reasoning signed after it leaves too
    expect(thinking(out)).toEqual([])
  })

  it('every tool call still has its result in the provider request, the folded ones included', () => {
    const out = foldEarlierTurns(history(), 7)
    const body = JSON.parse(createAnthropicAdapter().build({ model: 'claude-sonnet-5-5', messages: out, tools: [] }).body as string) as { messages: { role: string; content: Obj[] | string }[] }
    const uses = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b['type'] === 'tool_use').map((b) => b['id']) : []))
    const results = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b['type'] === 'tool_result').map((b) => b['tool_use_id']) : []))
    expect(results).toEqual(uses)
    // and only the turn in progress carries a picture
    expect(JSON.stringify(body.messages.slice(0, 5))).not.toContain('"image"')
  })

  it('folds the same history to the same bytes on every request of a turn, and the next turn keeps them', () => {
    const ms = history()
    const first = JSON.stringify(foldEarlierTurns(ms, 7))
    ms.push({ role: 'assistant', content: 'Raked them back.' })
    const again = foldEarlierTurns(ms, 7)
    expect(JSON.stringify(again.slice(0, 11))).toBe(first)
    // the next turn: the earlier turns' lines stay byte for byte, only the turn just ended is shortened
    ms.push(ask('add portholes'))
    const next = foldEarlierTurns(ms, ms.length)
    expect(JSON.stringify(next.slice(0, 6))).toBe(JSON.stringify(again.slice(0, 6)))
    expect(next[8]).toEqual({ role: 'tool', callId: 't3', content: 'design.look, earlier turn (shortened): done: Looked at the model. design obj_1.' })
    expect((next[10] as { content: string }).content).toBe('design.edit_step, earlier turn (shortened): done: Edited step 5, Ellipse extrude 15.1 mm: it leans 5 degrees toward -x. design obj_1.')
  })

  it('reads a result the same way after the runtime took its picture out', () => {
    const ms = history()
    const before = JSON.stringify(foldEarlierTurns(ms, 7).slice(0, 6))
    const m = ms[3] as { content: string }
    ms[3] = { role: 'tool', callId: 't1', content: `${m.content}\n(Older image removed to save space.)` }
    expect(JSON.stringify(foldEarlierTurns(ms, 7).slice(0, 6))).toBe(before)
  })

  it('keeps a plan read back from the project whole: it comes before the chat turns', () => {
    const plan = big('Approved', { planId: 'plan_1' })
    const ms: LlmMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: PLAN_SEED_NOTE }, call('s1', 'design.plan'), answer('s1', plan), ask('build it'), call('t1', 'geom.extrude'), answer('t1', big('Joined: step 1')), ask('make it taller')]
    const out = foldEarlierTurns(ms, 8)
    expect(out[3]).toBe(ms[3])
    expect((out[6] as { content: string }).content).toMatch(/^geom\.extrude, earlier turn \(shortened\)/)
  })

  it('sends nothing shortened on a chat first turn', () => {
    const ms = history().slice(0, 6)
    expect(foldEarlierTurns(ms, 2)).toEqual(ms)
  })
})

describe('the folded line', () => {
  it('takes the first sentence of a long summary and cuts it at a word', () => {
    expect(firstSentence('Edited step 6, Circle extrude 29.03 mm. Then more.')).toBe('Edited step 6, Circle extrude 29.03 mm')
    const long = firstSentence(`Titanic: ${'one check failed on stands on '.repeat(20)}`)
    expect(long.length).toBeLessThanOrEqual(203)
    expect(long.endsWith('...')).toBe(true)
  })

  it('reads a result cut short at the size limit, which no longer parses', () => {
    const cut = `${big('Edited step 4, Rectangle extrude 3.1 mm', { design: 'obj_1' }).slice(0, 200)}...(truncated)`
    expect(foldedLine('design.edit_step', cut)).toBe('design.edit_step, earlier turn (shortened): done: Edited step 4, Rectangle extrude 3.1 mm.')
  })

  it('names the ids of an untrusted result from its data, once', () => {
    const r = JSON.stringify({ ok: true, summary: 'lookup_1: found 3 of 5 sizes', result: { untrusted: true, note: 'n', data: { lookupId: 'lookup_1', subject: 'RMS Titanic' } } })
    expect(foldedLine('design.lookup_sizes', r)).toBe('design.lookup_sizes, earlier turn (shortened): done: lookup_1: found 3 of 5 sizes.')
  })
})

describe('the cache point at the turn start', () => {
  it('goes on the last block of the turn opening request, as a text block', () => {
    const adapter = createAnthropicAdapter()
    const ms = history()
    const body = JSON.parse(adapter.build({ model: 'claude-sonnet-5-5', messages: foldEarlierTurns(ms, 7), tools: [], cacheAt: 6 }).body as string) as { messages: { role: string; content: unknown }[] }
    const marked = body.messages.flatMap((m, i) => (Array.isArray(m.content) ? (m.content as Obj[]).filter((b) => b['cache_control']).map(() => i) : []))
    expect(marked).toEqual([5])
    expect(body.messages[5]!.content).toEqual([{ type: 'text', text: (ms[6] as { content: string }).content, cache_control: { type: 'ephemeral' } }])
  })

  it('is asked for by a cloud turn once the fold shortens something, and the request carries the folded lines', async () => {
    const extrude = defineTool<{ name: string }>({ name: 'geom.extrude', version: '1', description: 'One feature', source: 'command', permission: 'slice', input: z.object({ name: z.string() }), run: async (i) => ({ summary: `Built ${i.name}`, output: { design: 'd1', filler: pad } }) })
    const client = createScriptedClient([{ reasoning: 'r1', calls: [{ name: 'geom.extrude', args: { name: 'Body' } }] }, { text: 'Built the body.' }, { calls: [{ name: 'geom.extrude', args: { name: 'Roof' } }] }, { text: 'Added the roof.' }], { chunk: false })
    const p = createPilot({
      host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never,
      config: { ...DEFAULT_CONFIG, maxSteps: 20, maxToolCalls: 40 },
      policy: DEFAULT_POLICY,
      client,
      builtins: false,
      tools: [extrude] as never[],
    })
    for await (const _e of p.run('s', 'make a toy car')) void _e
    for await (const _e of p.run('s', 'add a roof')) void _e
    const reqs = client.requests
    expect(reqs.slice(0, 2).map((r) => r.cacheAt)).toEqual([undefined, undefined])
    const second = reqs[2]!
    const at = second.cacheAt!
    expect(second.messages[at]).toMatchObject({ role: 'user', content: expect.stringContaining('User request:\nadd a roof') })
    const earlier = second.messages.slice(0, at).filter((m) => m.role === 'tool')
    expect(earlier).toEqual([{ role: 'tool', callId: expect.any(String), content: expect.stringMatching(/^geom\.extrude, earlier turn \(shortened\): done: Built Body\. design d1\./) }])
    // the turn in progress goes whole
    expect(reqs[3]!.messages.slice(at + 1).some((m) => m.role === 'tool' && m.content.includes('filler'))).toBe(true)
  })
})
