// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Free mimir answers 429 slow_down past an install's calls per minute (20 on desktop, 10 per person on the web), and a
// long plan sends a model request every few seconds. A slow_down mid-build waits and carries on with the same step
// instead of ending the run as an error; past a full rate window of waiting it stops like a run cut off at its limit,
// with the sheet kept, so "keep going" builds the rest. No test here really waits: the runtime's sleep is replaced.
import { DEFAULT_POLICY, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, sheetTool, type LlmClient, type ScriptStep } from '../src/index'
import { SLOW_DOWN_GIVE_UP_MS, SLOW_DOWN_LINE, SLOW_DOWN_WAIT_MS } from '../src/runtime'

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
    },
  })
  const runs: PilotEvent[][] = []
  const say = async (message: string) => {
    const events: PilotEvent[] = []
    for await (const e of p.run('s', message)) {
      events.push(e)
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, {})
    }
    runs.push(events)
    return events
  }
  return { log, waits, say, runs }
}

const done = (events: PilotEvent[]) => events.find((e) => e.type === 'done') as { stopReason: string } | undefined
const errors = (events: PilotEvent[]) => events.filter((e) => e.type === 'error')
const said = (events: PilotEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')

describe('a slow_down from the proxy mid-build', () => {
  it('waits and carries on with the same step, so the part is built and the run ends as usual', async () => {
    // the fourth request (after the sheet, the base and its hollow) is refused once
    const s = setup(proxied([{ calls: [SHEET] }, x('Base'), x('Base hollow'), x('Vents'), x('Lid'), { text: 'Built.' }], (n) => n === 3))
    const events = await s.say('A Pi 5 case with a lid')
    expect(s.waits).toEqual([SLOW_DOWN_WAIT_MS])
    expect(s.log).toEqual(['Base', 'Base hollow', 'Vents', 'Lid'])
    expect(errors(events)).toEqual([])
    expect(done(events)?.stopReason).toBe('end')
  })

  it('a refusal after each wait for a whole rate window stops the run cut short, with the sheet kept for "keep going"', async () => {
    let refusing = true
    const steps: ScriptStep[] = [{ calls: [SHEET] }, x('Base'), x('Base hollow'), x('Lid'), { text: 'The lid is built.' }]
    const s = setup(proxied(steps, (n) => refusing && n >= 3))
    const first = await s.say('A Pi 5 case with a lid')
    expect(s.waits.reduce((a, b) => a + b, 0)).toBe(SLOW_DOWN_GIVE_UP_MS)
    expect(s.waits.every((w) => w === SLOW_DOWN_WAIT_MS)).toBe(true)
    expect(errors(first)).toEqual([])
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
