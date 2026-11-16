// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud's proxy answers 502 `unreachable` when its own request to the model failed before any reply: nothing was
// generated, so the run sends the same step once more after a short wait, unseen. A second failure in a row shows the
// proxy's words as they are today. A request whose reply had shown words, or that the proxy refused, is never sent again.
import { DEFAULT_POLICY, type LlmHttpRequest, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPilot, createTransportClient, DEFAULT_CONFIG } from '../src/index'
import { NETWORK_RETRY_MS } from '../src/runtime'

const UNREACHABLE = 'mimir could not reach the model. Try again in a moment. (error 25597f31)'
const enc = new TextEncoder()

const sse = (events: object[]): string => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const START = { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }
const REPLY = sse([
  START,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is your hull.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
])
/** The start of a reply that thinks first, then the connection resets. */
const THINKING = sse([
  START,
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The hull first.' } },
])
/** The start of a reply with words, then the connection resets. */
const WORDS = sse([
  START,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is ' } },
])

/** What the fake fetch does on each request, in order. */
type Answer =
  | { refuse: number; code: string; message: string }
  | { reset: 'before' }
  | { reply: string }
  | { cutAfter: string }

const refuse = (status: number, code: string, message: string): Answer => ({ refuse: status, code, message })

/** A fetch that answers `answers` in turn, the way mimir cloud's proxy does, and counts its requests. */
function fakeFetch(answers: Answer[]) {
  const calls: string[] = []
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url)
    const a = answers[calls.length - 1]
    if (!a) throw new Error(`unexpected request ${calls.length}`)
    if ('reset' in a) throw new TypeError('fetch failed')
    if ('refuse' in a) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', code: a.code, message: a.message } }), { status: a.refuse, headers: { 'content-type': 'application/json' } })
    const text = 'reply' in a ? a.reply : a.cutAfter
    const cut = 'cutAfter' in a
    // the reply's bytes are read first; a cut one then fails on the next read, as a reset connection does
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (!sent) {
          sent = true
          ctl.enqueue(enc.encode(text))
        } else if (cut) ctl.error(new TypeError('network error'))
        else ctl.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-sx-model': 'claude-haiku-5-5' } })
  }
  return { calls, fetch }
}

/**
 * The desktop host's transport for mimir cloud over `fetch`: a refusal comes back as its status, the proxy's code and
 * `<status>: <message>`; a request that got no answer at all as status 0.
 */
function hostTransport(fetch: (url: string) => Promise<Response>): LlmTransport {
  return {
    async available() {
      return true
    },
    async *stream(req: LlmHttpRequest, _signal?: AbortSignal, onHeaders?: (h: Record<string, string>) => void) {
      let res: Response
      try {
        res = await fetch(req.url)
      } catch (e) {
        throw Object.assign(new Error(`mimir-cloud request failed: ${(e as Error).message}`), { name: 'TransportError', status: 0 })
      }
      if (!res.ok) {
        const e = ((await res.json()) as { error: { code: string; message: string } }).error
        throw Object.assign(new Error(`${res.status}: ${e.message}`), { name: 'TransportError', status: res.status, code: e.code })
      }
      onHeaders?.({ 'x-sx-model': res.headers.get('x-sx-model') ?? '' })
      const reader = res.body!.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        if (value) yield value
      }
    },
  } as LlmTransport
}

function setup(answers: Answer[]) {
  const { calls, fetch } = fakeFetch(answers)
  const transport = hostTransport(fetch)
  const p = createPilot({
    host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: transport } as never,
    config: { ...DEFAULT_CONFIG, maxSteps: 4, maxToolCalls: 4 },
    policy: DEFAULT_POLICY,
    client: createTransportClient(transport, 'mimir-cloud', { baseUrl: 'https://cloud.test' }),
    builtins: false,
    tools: [],
  })
  /** Runs one message to the end, moving the fake clock along as the run waits. */
  const say = async (message: string) => {
    const events: PilotEvent[] = []
    const run = (async () => {
      for await (const e of p.run('s', message)) events.push(e)
    })()
    await vi.runAllTimersAsync()
    await run
    return events
  }
  return { calls, p, say }
}

const errors = (events: PilotEvent[]) => (events.filter((e) => e.type === 'error') as { message: string; code?: string }[]).map((e) => e.message)
const replyText = (events: PilotEvent[]) => (events.filter((e) => e.type === 'text') as { delta: string }[]).map((e) => e.delta).join('')

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('mimir cloud could not reach the model', () => {
  it('sends the request once more after a short wait and gives the normal reply', async () => {
    const { calls, p } = setup([refuse(502, 'unreachable', UNREACHABLE), { reply: REPLY }])
    const events: PilotEvent[] = []
    const run = (async () => {
      for await (const e of p.run('s', 'make a hull')) events.push(e)
    })()
    // the second request waits out the retry delay on the clock
    await vi.advanceTimersByTimeAsync(NETWORK_RETRY_MS - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.runAllTimersAsync()
    await run
    expect(calls).toHaveLength(2)
    expect(errors(events)).toEqual([])
    expect(replyText(events)).toBe('Here is your hull.')
  })

  it('also sends it once more when the connection reset before any reply', async () => {
    const { calls, say } = setup([{ reset: 'before' }, { reply: REPLY }])
    const events = await say('make a hull')
    expect(calls).toHaveLength(2)
    expect(errors(events)).toEqual([])
    expect(replyText(events)).toBe('Here is your hull.')
  })

  it('shows the proxy words as today when the second try fails too', async () => {
    const { calls, say } = setup([refuse(502, 'unreachable', UNREACHABLE), refuse(502, 'unreachable', UNREACHABLE)])
    const events = await say('make a hull')
    expect(calls).toHaveLength(2)
    expect(errors(events)).toEqual([UNREACHABLE])
    expect((events.find((e) => e.type === 'error') as { code?: string }).code).toBe('unreachable')
  })
})

describe('a reply cut off before anything was shown', () => {
  // thinking is not shown as reply text, so a reply lost after it is sent once more, as before
  it('is sent once more after its thinking had started', async () => {
    const { calls, say } = setup([{ cutAfter: THINKING }, { reply: REPLY }])
    const events = await say('make a hull')
    expect(calls).toHaveLength(2)
    expect(errors(events)).toEqual([])
    expect(replyText(events)).toBe('Here is your hull.')
  })
})

describe('a request that is never sent again', () => {
  it('a reply cut off after its first words', async () => {
    const { calls, say } = setup([{ cutAfter: WORDS }, { reply: REPLY }])
    const events = await say('make a hull')
    expect(calls).toHaveLength(1)
    expect(errors(events)).toHaveLength(1)
    expect(replyText(events)).toBe('Here is ')
  })

  const refusals: [string, number, string, string][] = [
    ['a bad request', 400, 'provider_error', 'mimir could not get an answer to that. (error 1a2b3c4d)'],
    ['an unregistered install', 401, 'not_registered', 'This install is not registered with mimir.'],
    ["today's free use spent", 429, 'day_used', "You've used today's free mimir. It resets in 3 hours."],
    ['a busy model', 503, 'provider_busy', 'The model is busy right now. Try again in a moment. (error 1a2b3c4d)'],
    ['a paused account', 503, 'paused', 'Free mimir is paused right now.'],
  ]
  for (const [what, status, code, message] of refusals) {
    it(`${what} (${status} ${code})`, async () => {
      const { calls, say } = setup([refuse(status, code, message), { reply: REPLY }])
      const events = await say('make a hull')
      expect(calls).toHaveLength(1)
      expect(errors(events)).toEqual([message])
    })
  }
})
