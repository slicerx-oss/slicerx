// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Free mimir answers 429 slow_down past an install's calls per minute (20 on desktop, 10 per person on the web), and a
// long plan sends a model request every few seconds. A slow_down mid-build shows its line at once, then waits and
// carries on with the same step instead of ending the run as an error; past a full rate window of waiting it stops like
// a run cut off at its limit, with the sheet kept, so "keep going" builds the rest. No test here really waits: the
// runtime's sleep is replaced.
import { DEFAULT_POLICY, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, sheetTool, type LlmClient, type ScriptStep } from '../src/index'
import { abortableSleep, SLOW_DOWN_GIVE_UP_MS, SLOW_DOWN_LINE, SLOW_DOWN_WAIT_MS } from '../src/runtime'

const SHEET = { name: 'pilot.sheet', args: { title: 'Case sizes', dims: [{ key: 'length', label: 'Length', value: 96, unit: 'mm', source: 'guess' }] } }
const x = (name: string) => ({ calls: [{ name: 'geom.extrude', args: { name, design: 'd1' } }] })

/** The scripted model behind a proxy that answers slow_down to the requests `refuse` picks (counted from 0). */
function proxied(steps: ScriptStep[], refuse: (n: number) => boolean): LlmClient & { requests: unknown[] } {
  const inner = createScriptedClient(steps, { chunk: false })
  let n = 0
  return {
    provider: 'mimir-cloud',
    requests: inner.requests,
    async *stream(req, signal) {
      if (refuse(n++)) {
        yield { type: 'error', message: 'Slow down a moment, then try again.', retryable: false, code: 'slow_down' }
        yield { type: 'done', stop: 'error' }
        return
      }
      yield* inner.stream(req, signal)
    },
  }
}

function setup(client: LlmClient) {
  const log: string[] = []
  const waits: number[] = []
  // how many events had reached the reader by the end of each wait
  const waitedAt: number[] = []
  let current: PilotEvent[] = []
  const extrude = defineTool<{ name: string; design?: string | undefined }>({
    name: 'geom.extrude',
    version: '1',
    description: 'One feature',
    source: 'command',
    permission: 'read',
    input: z.object({ name: z.string(), design: z.string().optional() }),
    async run(i) {
      log.push(i.name)
      return { summary: `Built ${i.name}`, output: { design: i.design ?? 'd1' } }
    },
  })
  const p = createPilot({
    host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never,
    config: { ...DEFAULT_CONFIG, maxSteps: 20, maxToolCalls: 40 },
    policy: DEFAULT_POLICY,
    client,
    builtins: false,
    tools: [sheetTool(), extrude] as never[],
    sleep: async (ms) => {
      waits.push(ms)
      // a tick for the reader to take what the run sent before it began to wait
      await new Promise((r) => setTimeout(r, 0))
      waitedAt.push(current.length)
    },
  })
  const runs: PilotEvent[][] = []
  const say = async (message: string) => {
    const events: PilotEvent[] = []
    current = events
    for await (const e of p.run('s', message)) {
      events.push(e)
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, {})
    }
    runs.push(events)
    return events
  }
  return { log, waits, waitedAt, say, runs }
}

const done = (events: PilotEvent[]) => events.find((e) => e.type === 'done') as { stopReason: string } | undefined
const errors = (events: PilotEvent[]) => events.filter((e) => e.type === 'error')
const slowNotices = (events: PilotEvent[]) => errors(events).filter((e) => e.type === 'error' && e.code === 'slow_down')
const said = (events: PilotEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')

describe('a slow_down from the proxy mid-build', () => {
  it('waits and carries on with the same step, so the part is built and the run ends as usual', async () => {
    // the fourth request (after the sheet, the base and its hollow) is refused once
    const s = setup(proxied([{ calls: [SHEET] }, x('Base'), x('Base hollow'), x('Vents'), x('Lid'), { text: 'Built.' }], (n) => n === 3))
    const events = await s.say('A Pi 5 case with a lid')
    expect(s.waits).toEqual([SLOW_DOWN_WAIT_MS])
    expect(s.log).toEqual(['Base', 'Base hollow', 'Vents', 'Lid'])
    expect(slowNotices(events)).toHaveLength(1)
    expect(done(events)?.stopReason).toBe('end')
  })

  it('says so at once, before the first wait, with the code that links to usage', async () => {
    const s = setup(proxied([{ calls: [SHEET] }, x('Base'), { text: 'Built.' }], (n) => n === 1))
    const events = await s.say('A plate')
    // the notice reaches the person while mimir waits, not after, and comes once for the streak
    const at = events.findIndex((e) => e.type === 'error')
    expect(slowNotices(events)).toEqual([{ type: 'error', message: 'Slow down a moment, then try again.', retryable: true, code: 'slow_down' }])
    expect(at).toBeGreaterThanOrEqual(0)
    expect(s.waitedAt).toHaveLength(1)
    expect(at).toBeLessThan(s.waitedAt[0]!)
    expect(done(events)?.stopReason).toBe('end')
  })

  it('a refusal after each wait for a whole rate window stops the run cut short, with the sheet kept for "keep going"', async () => {
    let refusing = true
    const steps: ScriptStep[] = [{ calls: [SHEET] }, x('Base'), x('Base hollow'), x('Lid'), { text: 'The lid is built.' }]
    const s = setup(proxied(steps, (n) => refusing && n >= 3))
    const first = await s.say('A Pi 5 case with a lid')
    expect(s.waits.reduce((a, b) => a + b, 0)).toBe(SLOW_DOWN_GIVE_UP_MS)
    expect(s.waits.every((w) => w === SLOW_DOWN_WAIT_MS)).toBe(true)
    // one notice for the whole streak of refusals, not one per wait
    expect(slowNotices(first)).toHaveLength(1)
    expect(done(first)?.stopReason).toBe('max_steps')
    expect(said(first)).toContain(SLOW_DOWN_LINE)
    expect(s.log).toEqual(['Base', 'Base hollow'])
    // the proxy takes calls again: "keep going" builds the lid under the sheet already confirmed
    refusing = false
    const second = await s.say('keep going')
    expect(s.log).toEqual(['Base', 'Base hollow', 'Lid'])
    expect(second.some((e) => e.type === 'sheet')).toBe(false)
    expect(done(second)?.stopReason).toBe('end')
  })

  it('a refusal that is not slow_down still ends the run as an error, with no wait', async () => {
    const inner = createScriptedClient([{ calls: [SHEET] }, x('Base')], { chunk: false })
    let n = 0
    const client: LlmClient = {
      provider: 'mimir-cloud',
      async *stream(req, signal) {
        if (n++ === 1) {
          yield { type: 'error', message: "You've used today's free mimir.", retryable: false, code: 'day_used' }
          yield { type: 'done', stop: 'error' }
          return
        }
        yield* inner.stream(req, signal)
      },
    }
    const s = setup(client)
    const events = await s.say('A Pi 5 case')
    expect(s.waits).toEqual([])
    expect(done(events)?.stopReason).toBe('error')
  })
})

describe('the wait before a step is sent again', () => {
  it('ends at once for a run already canceled, and on cancel otherwise', async () => {
    vi.useFakeTimers()
    try {
      const gone = new AbortController()
      gone.abort()
      let done = false
      void abortableSleep(SLOW_DOWN_WAIT_MS, gone.signal).then(() => (done = true))
      await Promise.resolve()
      await Promise.resolve()
      expect(done).toBe(true)
      const live = new AbortController()
      let later = false
      void abortableSleep(SLOW_DOWN_WAIT_MS, live.signal).then(() => (later = true))
      await Promise.resolve()
      expect(later).toBe(false)
      live.abort()
      await Promise.resolve()
      await Promise.resolve()
      expect(later).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
