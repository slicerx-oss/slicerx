// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A model request lost to the network is no turn: the run sends the same step once more after a short wait and goes on
// as if nothing happened. A second loss in a row ends the run with one plain line, not the transport's words.
import { DEFAULT_POLICY, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type LlmClient, type ScriptStep } from '../src/index'
import { NETWORK_LINE, NETWORK_RETRY_MS } from '../src/runtime'

/** The scripted model behind a connection that drops on the requests `drop` picks (counted from 0). */
function flaky(steps: ScriptStep[], drop: (n: number) => boolean, how: 'throw' | 'event'): LlmClient & { requests: unknown[] } {
  const inner = createScriptedClient(steps, { chunk: false })
  let n = 0
  return {
    provider: 'anthropic',
    requests: inner.requests,
    async *stream(req, signal) {
      if (drop(n++)) {
        if (how === 'throw') throw Object.assign(new Error('anthropic request failed: fetch failed: '), { name: 'TransportError', status: 0 })
        yield { type: 'error', message: 'anthropic request failed: fetch failed: ', retryable: true }
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
  const extrude = defineTool<{ name: string }>({
    name: 'geom.extrude',
    version: '1',
    description: 'One feature',
    source: 'command',
    permission: 'read',
    input: z.object({ name: z.string() }),
    async run(i) {
      log.push(i.name)
      return { summary: `Built ${i.name}`, output: {} }
    },
  })
  const p = createPilot({
    host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never,
    config: { ...DEFAULT_CONFIG, maxSteps: 20, maxToolCalls: 40 },
    policy: DEFAULT_POLICY,
    client,
    builtins: false,
    tools: [extrude] as never[],
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  const say = async (message: string) => {
    const events: PilotEvent[] = []
    for await (const e of p.run('s', message)) events.push(e)
    return events
  }
  return { log, waits, say }
}

const steps: ScriptStep[] = [{ calls: [{ name: 'geom.extrude', args: { name: 'Base' } }] }, { text: 'Built the base.' }]

describe('a request lost to the network', () => {
  for (const how of ['throw', 'event'] as const) {
    it(`is sent once more and the run goes on, as if nothing happened (${how})`, async () => {
      const { log, waits, say } = setup(flaky(steps, (n) => n === 0, how))
      const events = await say('make a base')
      expect(log).toEqual(['Base'])
      expect(waits).toEqual([NETWORK_RETRY_MS])
      expect(events.some((e) => e.type === 'error')).toBe(false)
      const done = events.find((e) => e.type === 'done') as { stopReason?: string } | undefined
      expect(done?.stopReason).not.toBe('error')
    })
  }

  it('ends the run with one plain line when the second try is lost too', async () => {
    const { log, waits, say } = setup(flaky(steps, (n) => n < 2, 'throw'))
    const events = await say('make a base')
    expect(log).toEqual([])
    expect(waits).toEqual([NETWORK_RETRY_MS])
    const errors = events.filter((e) => e.type === 'error') as { message: string }[]
    expect(errors.map((e) => e.message)).toEqual([NETWORK_LINE])
  })

  it('gets a fresh retry after a step that went through', async () => {
    const { log, waits, say } = setup(flaky(steps, (n) => n === 0 || n === 2, 'event'))
    const events = await say('make a base')
    expect(log).toEqual(['Base'])
    expect(waits).toEqual([NETWORK_RETRY_MS, NETWORK_RETRY_MS])
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('leaves any other failure as it was: said at once, no retry', async () => {
    const client: LlmClient = {
      provider: 'anthropic',
      async *stream() {
        yield { type: 'error', message: 'anthropic 400: bad request', retryable: false }
        yield { type: 'done', stop: 'error' }
      },
    }
    const { waits, say } = setup(client)
    const events = await say('make a base')
    expect(waits).toEqual([])
    expect((events.find((e) => e.type === 'error') as { message: string }).message).toBe('anthropic 400: bad request')
  })
})
