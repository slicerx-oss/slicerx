// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab makes its runtime again when its setup changes (switching to the phone layout and back takes the built-in
// commands away and brings them back). A send card waiting on a runtime it replaced, however many rebuilds back, is
// still answered: Not now and Print reach the run that asked, once, and the run goes on. Replaced runtimes with nothing
// going and nothing waiting are let go, and no more than 8 are kept. An answer no runtime waits for is still refused.
import { DEFAULT_POLICY, type ApprovalRequest, type LlmTransport, type Pilot, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type PilotTool } from '@slicerx/pilot'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { answersReachTheirRun, forgetReplaced, replacedCount, retire } from '../src/workspaces/mimir/answers'

const printers = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost

/** A tool that waits on the person's card, as printer.queue does, and says what it did once answered. */
const send = defineTool({
  name: 'test.send',
  version: '1',
  description: 'Sends the plate after the card',
  source: 'skill',
  permission: 'profile',
  input: z.object({}),
  async approval() {
    return { title: 'Send plate 1?', lines: ['Plate 1'], actions: [] }
  },
  async run() {
    return { summary: 'Sent' }
  },
}) as PilotTool<never>

function runtime(): Pilot {
  return answersReachTheirRun(
    createPilot({
      host: { printers, approvals: createApprovalBroker(), llm: {} as LlmTransport },
      config: DEFAULT_CONFIG,
      policy: DEFAULT_POLICY,
      client: createScriptedClient([{ calls: [{ name: 'test.send', args: {} }] }, { text: 'Done.' }], { chunk: false }),
      builtins: false,
      tools: [send] as never[],
    }),
  )
}

/** Runs a turn on `pilot` in the background; resolves the card's request once it shows. */
function start(pilot: Pilot) {
  const events: PilotEvent[] = []
  let shown: (r: ApprovalRequest) => void = () => undefined
  const card = new Promise<ApprovalRequest>((r) => (shown = r))
  const done = (async () => {
    for await (const e of pilot.run('tab', 'send it')) {
      events.push(e)
      if (e.type === 'approval_request') shown(e.request)
    }
  })()
  return { events, card, done }
}

afterEach(() => forgetReplaced())

describe('a send card across a runtime made again', () => {
  for (const answer of ['deny', 'approve'] as const) {
    it(`the ${answer === 'deny' ? 'Not now' : 'Print'} answer reaches the runtime that asked`, async () => {
      const first = runtime()
      const turn = start(first)
      const request = await turn.card
      // the layout switch: the tab makes its runtime again, and the chat now answers through the new one
      retire(first)
      const second = runtime()
      await second.resolveApproval(request.id, answer === 'deny' ? { kind: 'deny', reason: 'canceled' } : { kind: 'approve' })
      await turn.done
      // the run that asked heard the answer: Print runs the send, Not now sends nothing
      expect(turn.events.find((e) => e.type === 'approval_resolved')).toMatchObject({ requestId: request.id, decision: { kind: answer } })
      const sent = turn.events.some((e) => e.type === 'tool_result' && e.ok)
      expect(sent).toBe(answer === 'approve')
      expect(turn.events.at(-1)).toMatchObject({ type: 'done' })
      // answered once: a second answer finds no wait anywhere
      await expect(second.resolveApproval(request.id, { kind: 'approve' })).rejects.toThrow(/No pending approval/)
    })
  }

  it('a card answered after three rebuilds in a row still reaches the run that asked, and idle runtimes are let go', async () => {
    const first = runtime()
    const turn = start(first)
    const request = await turn.card
    // three rebuilds while the card waits; the ones in between never ran anything, so only the first is kept
    retire(first)
    const second = runtime()
    retire(second)
    const third = runtime()
    retire(third)
    const fourth = runtime()
    expect(replacedCount()).toBe(1)
    await fourth.resolveApproval(request.id, { kind: 'deny', reason: 'canceled' })
    await turn.done
    expect(turn.events.find((e) => e.type === 'approval_resolved')).toMatchObject({ requestId: request.id, decision: { kind: 'deny' } })
    expect(turn.events.some((e) => e.type === 'tool_result' && e.ok)).toBe(false)
    // it resolved once: the same answer again finds no wait anywhere
    await expect(fourth.resolveApproval(request.id, { kind: 'deny', reason: 'canceled' })).rejects.toThrow(/No pending approval/)
    // the first runtime's run is over, so the next rebuild lets it go too
    retire(fourth)
    expect(replacedCount()).toBe(0)
  })

  it('keeps at most 8 replaced runtimes, even when each still waits', async () => {
    for (let i = 0; i < 10; i++) {
      const pilot = runtime()
      await start(pilot).card
      retire(pilot)
    }
    expect(replacedCount()).toBe(8)
  })

  it('an answer no runtime waits for is refused', async () => {
    const first = runtime()
    retire(first)
    const second = runtime()
    await expect(second.resolveApproval('apr_none', { kind: 'approve' })).rejects.toThrow('No pending approval apr_none')
  })
})
