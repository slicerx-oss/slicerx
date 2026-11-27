// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab's event tap (workspaces/mimir/event-tap.ts): every event the runtime logs reaches the listeners as it is
// emitted, so a listener that stops the run on a usage event stops it before the next model request. Scripts reach it
// as window.__mimirEvents with localStorage 'slicerx.debug' set.
import { DEFAULT_POLICY, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { createMemorySessionStore, createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type ScriptStep } from '@slicerx/pilot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createEventTap } from '../src/workspaces/mimir/event-tap'

type Hook = { on: (fn: (sessionId: string, event: PilotEvent) => void) => () => void }
const win = (): { __mimirEvents?: Hook } => window as unknown as { __mimirEvents?: Hook }

const steps: ScriptStep[] = [{ calls: [{ name: 'geom.extrude', args: { name: 'Base' } }] }, { calls: [{ name: 'geom.extrude', args: { name: 'Lid' } }] }, { text: 'Built the base and the lid.' }]

function setup() {
  const tap = createEventTap()
  const store = tap.wrap(createMemorySessionStore())
  const client = createScriptedClient(steps, { chunk: false })
  const built: string[] = []
  const extrude = defineTool<{ name: string }>({
    name: 'geom.extrude',
    version: '1',
    description: 'One feature',
    source: 'command',
    permission: 'read',
    input: z.object({ name: z.string() }),
    async run(i) {
      built.push(i.name)
      return { summary: `Built ${i.name}`, output: {} }
    },
  })
  const pilot = createPilot({
    host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never,
    config: { ...DEFAULT_CONFIG, maxSteps: 20, maxToolCalls: 40 },
    policy: DEFAULT_POLICY,
    client,
    builtins: false,
    tools: [extrude] as never[],
    store,
  })
  const say = async (message: string, signal?: AbortSignal) => {
    const events: PilotEvent[] = []
    for await (const e of pilot.run('s', message, signal ? { signal } : {})) events.push(e)
    return events
  }
  return { tap, store, client, built, say }
}

describe('the mimir event tap', () => {
  it('shows each logged event to the listeners, in order, and the store still keeps it', async () => {
    const { tap, store, say } = setup()
    const seen: string[] = []
    tap.on((sessionId, e) => seen.push(`${sessionId}:${e.type}`))
    const events = await say('make a base and a lid')
    expect(seen.filter((s) => s.endsWith(':usage'))).toHaveLength(3)
    expect(seen).toEqual(events.map((e) => `s:${e.type}`))
    expect((await store.read('s')).map((e) => e.type)).toEqual(events.map((e) => e.type))
  })

  it('reports usage with the runtime totals as the provider gave them', async () => {
    const { tap, say } = setup()
    const usage: PilotEvent[] = []
    tap.on((_, e) => {
      if (e.type === 'usage') usage.push(e)
    })
    await say('make a base and a lid')
    for (const u of usage) {
      expect(u.type === 'usage' && u.inputTokens > 0 && u.outputTokens > 0).toBe(true)
    }
  })

  it('lets a listener stop the run on a usage event before the next model request', async () => {
    const { tap, client, built, say } = setup()
    const ac = new AbortController()
    tap.on((_, e) => {
      if (e.type === 'usage') ac.abort()
    })
    const events = await say('make a base and a lid', ac.signal)
    expect(client.requests).toHaveLength(1)
    expect(built).not.toContain('Lid')
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1)
    const done = events.find((e) => e.type === 'done') as { stopReason?: string } | undefined
    expect(done?.stopReason).toBe('canceled')
  })

  it('keeps the run going when a listener throws, and stops calling a removed listener', async () => {
    const { tap, client, say } = setup()
    tap.on(() => {
      throw new Error('a broken script')
    })
    let calls = 0
    const off = tap.on(() => void calls++)
    off()
    const events = await say('make a base and a lid')
    expect(calls).toBe(0)
    expect(client.requests).toHaveLength(3)
    const done = events.find((e) => e.type === 'done') as { stopReason?: string } | undefined
    expect(done?.stopReason).toBe('end')
  })
})

describe('the mimir event tap test hook', () => {
  beforeEach(() => {
    vi.resetModules()
    delete win().__mimirEvents
  })
  afterEach(() => {
    localStorage.removeItem('slicerx.debug')
    delete win().__mimirEvents
  })

  it('is installed when slicerx.debug is set, on the tab tap', async () => {
    localStorage.setItem('slicerx.debug', '1')
    const mod = await import('../src/workspaces/mimir/event-tap')
    expect(typeof win().__mimirEvents?.on).toBe('function')
    const seen: string[] = []
    const off = win().__mimirEvents!.on((_, e) => seen.push(e.type))
    await mod.mimirEvents.wrap(createMemorySessionStore()).append('s', { type: 'usage', inputTokens: 10, outputTokens: 2 })
    off()
    await mod.mimirEvents.wrap(createMemorySessionStore()).append('s', { type: 'usage', inputTokens: 10, outputTokens: 2 })
    expect(seen).toEqual(['usage'])
  })

  it('is absent when slicerx.debug is not set', async () => {
    await import('../src/workspaces/mimir/event-tap')
    expect(win().__mimirEvents).toBeUndefined()
  })
})
