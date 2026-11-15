// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How design.lookup_sizes reads a web answer into sizes. A model answering a sizes search does not always label each
// line with the size's name as asked: it may write "size:" on every line, shorten a name, or add words to it. An exact
// name wins; then a line whose name has the same head noun and no other part's words; then, when no line names a size
// asked, one line per size in the order asked. A line that gives a figure in metric and imperial is read by its metric
// one, as the source wrote it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSizes } from '../src/real-lookup'
import { createPlanRegistry } from '../src/design-check'
import { createCardPlans, tabToolset } from '../src/toolset'
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import type { DesignHost } from '@slicerx/cad-history'
import { createPilot, DEFAULT_CONFIG, type PilotTool, type ToolContext } from '@slicerx/pilot'

/** A recorded sizes answer (mimir cloud, the base model with web search): every line labeled "size", cut off at the output limit. */
const RECORDED = readFileSync(new URL('./fixtures/size-lookup-answer.txt', import.meta.url), 'utf8')
/**
 * The provider stream that answer came in, made neutral: every event and block as recorded (two web searches, their two
 * result blocks of 18 pages, the answer's text in parts, two of them citing a page), with invented pages, queries and figures.
 */
const STREAM = readFileSync(new URL('./fixtures/size-lookup-stream.sse', import.meta.url), 'utf8')
/** The sizes that request asked for, in its order. */
const ASKED = ['Overall length', 'Width (across)', 'Wall height to the roof', 'Tower height above the roof', 'Tower diameter', 'Spire height above ground', 'Wing length']

describe('reading a sizes answer', () => {
  it('reads the recorded answer whose lines are all labeled "size", in the order asked, by each line\'s metric figure', () => {
    expect(RECORDED.startsWith('size: 412 ft 6 in (125.7 m) Length:')).toBe(true)
    const { found, missing } = readSizes(RECORDED, ASKED)
    expect(found).toEqual([
      { size: 'Overall length', mm: 125700, said: '125.7 m' },
      { size: 'Width (across)', mm: 12600, said: '12.6 m' },
      { size: 'Tower height above the roof', mm: 17526, said: '57.5 ft', from: 'roof' },
    ])
    expect(missing).toEqual(['Wall height to the roof', 'Tower diameter', 'Spire height above ground', 'Wing length'])
  })

  it('matches a line to the size asked by the same head noun, either way round, and never to another part\'s size', () => {
    const answer = 'Width: 28 m\nTower height above the roof: 19 m\nLength: 300 m\nHeight: 40 m'
    const { found, missing } = readSizes(answer, ['Width (across)', 'Tower height', 'Overall length', 'Spire height', 'Wall height'])
    // "Height" alone could be the spire's or the wall's, so it is not read as either
    expect(found).toEqual([
      { size: 'Width (across)', mm: 28000, said: '28 m' },
      { size: 'Tower height', mm: 19000, said: '19 m' },
      { size: 'Overall length', mm: 300000, said: '300 m' },
    ])
    expect(missing).toEqual(['Spire height', 'Wall height'])
  })

  it('takes an exact name before a loose one', () => {
    const { found } = readSizes('Tower height above deck: 150 m\nTower height: 227 m', ['Tower height'])
    expect(found).toEqual([{ size: 'Tower height', mm: 227000, said: '227 m' }])
  })

  it('takes lines with no name, one per size, in the order asked', () => {
    const { found, missing } = readSizes('- 280 m\n- not found\n- 128 m', ['Deck length', 'Deck width', 'Main span'])
    expect(found).toEqual([
      { size: 'Deck length', mm: 280000, said: '280 m' },
      { size: 'Main span', mm: 128000, said: '128 m' },
    ])
    expect(missing).toEqual(['Deck width'])
  })

  it('does not read lines in order once any line names a size asked', () => {
    const { found, missing } = readSizes('Deck length: 280 m\nsize: 30 m', ['Deck length', 'Deck width'])
    expect(found).toEqual([{ size: 'Deck length', mm: 280000, said: '280 m' }])
    expect(missing).toEqual(['Deck width'])
  })

  it('reads a line that says its size was not found as not found, whatever figures it gives', () => {
    const answer = [
      'Gate height: 9 m (timber gates, 1 m deep), not found as a height figure; 30 m is given as the gate height above the river: 30 m',
      'Lock width: not found (the chamber is 12 m long)',
      'Lock length: 60 m',
    ].join('\n')
    const { found, missing } = readSizes(answer, ['Gate height', 'Lock width', 'Lock length'])
    expect(found.map((f) => [f.size, f.mm])).toEqual([['Lock length', 60000]])
    expect(missing).toEqual(['Gate height', 'Lock width'])
  })

  it('reads feet and inches together when a line gives no metric figure', () => {
    expect(readSizes('Overall length: 412 ft 6 in', ['Overall length']).found).toEqual([{ size: 'Overall length', mm: 125730, said: '412 ft 6 in' }])
  })
})

describe('design.lookup_sizes asks for a few published sizes', () => {
  const lookup = () => tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, createCardPlans(createPlanRegistry()), { nozzleMm: () => 0.4 }).find((t) => t.name === 'design.lookup_sizes')!

  it('is 1.2.0, takes at most 5 sizes, and says to derive the rest of the proportions from them', () => {
    const t = lookup()
    expect(t.version).toBe('1.2.0')
    expect(t.input.safeParse({ subject: 'a suspension bridge', sizes: ['a b', 'c d', 'e f', 'g h', 'i j'] }).success).toBe(true)
    expect(t.input.safeParse({ subject: 'a suspension bridge', sizes: ['a b', 'c d', 'e f', 'g h', 'i j', 'k l'] }).success).toBe(false)
    expect(t.description).toContain('at most 5 sizes sources commonly publish')
  })

  it('shows a source whose title is short or all capitals with its site, as the card and the result name it', async () => {
    const t = lookup()
    const cite = (title: string, url: string) => ({ id: url, title, url, kind: 'web' })
    const ctx = { sessionId: 's1', web: async () => ({ text: 'Tower height: 30 m', citations: [cite('STR', 'https://www.example.org/report/towers'), cite('STONE TOWER SURVEY', 'https://survey.example.net/a'), cite('Stone tower facts', 'https://example.com/facts')] }) } as unknown as ToolContext
    const out = await t.run(t.input.parse({ subject: 'a stone tower', sizes: ['Tower height'] }) as never, ctx)
    expect((out.output as { sources: { title: string }[] }).sources.map((x) => x.title)).toEqual(['STR (example.org)', 'STONE TOWER SURVEY (survey.example.net)', 'Stone tower facts'])
    expect(out.lookup?.source).toEqual({ title: 'STR (example.org)', url: 'https://www.example.org/report/towers' })
  })

  it('keeps no found sizes, and shows no card, when the web answer cites no page', async () => {
    const t = lookup()
    const ctx = { sessionId: 's1', web: async () => ({ text: 'Tower height: 30 m\nBase width: 8 m', citations: [] }) } as unknown as ToolContext
    const out = await t.run(t.input.parse({ subject: 'a stone tower', sizes: ['Tower height', 'Base width'] }) as never, ctx)
    expect(out.output).toEqual({ lookupId: 'lookup_1', subject: 'a stone tower', found: [], missing: ['Tower height', 'Base width'], sources: [] })
    expect(out.summary).toBe('lookup_1: found 0 of 2 sizes; no source gave Tower height, Base width')
    expect(out.lookup).toBeUndefined()
  })

  const enc = new TextEncoder()
  const event = (d: { type: string }): string => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`
  /** One chat turn that calls design.lookup_sizes through the real provider and runtime, its web search answered by `stream`. */
  async function lookupThrough(stream: string) {
    const reply = (blocks: { type: string }[], deltas: { type: string }[], stop: string): Uint8Array =>
      enc.encode([{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }, ...blocks.map((b) => ({ type: 'content_block_start', index: 0, content_block: b })), ...deltas.map((d) => ({ type: 'content_block_delta', index: 0, delta: d })), { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } }, { type: 'message_stop' }].map(event).join(''))
    const asked = { subject: 'the subject', sizes: ASKED.slice(0, 5) }
    const searched: string[] = []
    let turn = 0
    // the chat's turns call the tool, then end; the web search gets the stream
    const llm: LlmTransport = {
      available: async () => true,
      async *stream(req) {
        const body = JSON.parse(req.body) as { tools?: { type?: string }[]; messages: { content: unknown }[] }
        if (body.tools?.some((x) => x.type === 'web_search_20250305')) {
          searched.push(JSON.stringify(body.messages))
          yield enc.encode(stream)
        } else if (turn++ === 0) yield reply([{ type: 'tool_use', id: 'tu1', name: 'design__lookup_sizes', input: {} } as { type: string }], [{ type: 'input_json_delta', partial_json: JSON.stringify(asked) } as { type: string }], 'tool_use')
        else yield reply([{ type: 'text', text: '' } as { type: string }], [{ type: 'text_delta', text: 'Done.' } as { type: string }], 'end_turn')
      },
    }
    const t = lookup()
    const outs: Awaited<ReturnType<typeof t.run>>[] = []
    const ctxs: ToolContext[] = []
    const tool = { ...t, run: async (i: never, ctx: ToolContext) => { ctxs.push(ctx); const out = await t.run(i, ctx); outs.push(out); return out } } as unknown as PilotTool<never>
    const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm }
    const config = { ...DEFAULT_CONFIG, provider: 'anthropic', model: 'claude-haiku-5-5', models: { huginn: 'claude-haiku-5-5', muninn: 'claude-haiku-5-5' }, billing: 'key' as const }
    for await (const _ of createPilot({ host, config, policy: DEFAULT_POLICY, builtins: false, tools: [tool] }).run('s1', 'look its sizes up')) void _
    const out = outs[0]!.output as { found: { size: string; mm: number }[]; missing: string[]; sources: { title: string; url: string }[] }
    return { out, searched, ctx: ctxs[0]!, card: outs[0]!.lookup, summary: outs[0]!.summary }
  }
  /** The recorded stream's sizes, read from its answer. */
  const FOUND = [['Overall length', 125700], ['Width (across)', 12600], ['Tower height above the roof', 17526]]
  /** The pages its two searches returned, each once, in the order returned: 18 results, two of them a page already given. */
  const PAGES = ['facts', 'history', 'plans', 'overview', 'wiki', 'annex', 'guide', 'notes', 'survey', 'spire', 'heights', 'archive', 'drawings', 'records', 'models', 'gallery'].map((p) => ({ title: `Tower ${p}`, url: `https://example.org/tower-${p}` }))
  const CITED = PAGES.find((p) => p.url.endsWith('tower-overview'))!
  /** The recorded stream with none of its answer's parts citing a page. */
  const UNCITED = STREAM.split('\n\n').filter((e) => !e.includes('"citations_delta"')).join('\n\n')

  it('reads the recorded stream end to end through the provider, the web search and the tool: its sources are the pages its answer cites', async () => {
    const { out, searched, card } = await lookupThrough(STREAM)
    expect(searched.length).toBe(1)
    expect(out.found.map((f) => [f.size, f.mm])).toEqual(FOUND)
    expect(out.missing).toEqual(['Wall height to the roof', 'Tower diameter'])
    // the cited page once, though two parts cite it, and none of the pages the searches returned that it does not cite
    expect(out.sources).toEqual([CITED])
    expect(card?.source).toEqual(CITED)
  })

  /** The uncited stream with its searches' first result a page about something else. */
  const OTHER_FIRST = UNCITED.replaceAll('"title":"Tower facts"', '"title":"Harbor crane facts"').replaceAll('https://example.org/tower-facts', 'https://example.org/harbor-crane-facts')

  it('links no page when the answer cites none, though its searches returned some, and keeps its sizes as looked up', async () => {
    expect(OTHER_FIRST).not.toContain('citations_delta')
    expect(OTHER_FIRST).toContain('"web_search_tool_result"')
    expect(OTHER_FIRST).toContain('"title":"Harbor crane facts"')
    const { out, card, summary } = await lookupThrough(OTHER_FIRST)
    // the searches ran, so the sizes count as looked up
    expect(out.found.map((f) => [f.size, f.mm])).toEqual(FOUND)
    expect(summary).toBe('lookup_1: found 3 of 5 sizes; no source gave Wall height to the roof, Tower diameter')
    // but no page the answer did not cite is shown: the first result is about something else
    expect(out.sources).toEqual([])
    expect(card?.fields.length).toBeGreaterThan(0)
    expect(card?.source).toBeUndefined()
  })

  it('keeps no sources, and no found sizes, from an answer that ran no search', async () => {
    const text = [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: RECORDED } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }].map(event).join('')
    const { out } = await lookupThrough(text)
    expect(out.sources).toEqual([])
    expect(out.found).toEqual([])
    expect(out.missing).toEqual(ASKED.slice(0, 5))
  })

  it('gives a web question that is not a sizes lookup only the pages its answer cites', async () => {
    const { ctx } = await lookupThrough(UNCITED)
    expect((await ctx.web!('a question', ctx.signal)).citations).toEqual([])
    expect((await ctx.web!('a question', ctx.signal)).text).toBe(RECORDED)
  })
})
