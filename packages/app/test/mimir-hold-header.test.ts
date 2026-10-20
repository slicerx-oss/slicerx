// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pause and Resume in the mimir tab's header, wired to the tab's runtime: the button holds the run going before its
// next step, its label follows the hold, and Resume lets the same run go on. New conversation while the run is held
// cancels that run, so it never waits on behind the new chat. The tests wait on the run's own state, never a fixed time.
import { DEFAULT_POLICY, type ApprovalHost, type Host, type LlmTransport, type Pilot, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type ScriptStep } from '@slicerx/pilot'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// the tab's runtime is the test's own, so the test can see each run it starts and every hold the header sends
const tab = vi.hoisted(() => ({ pilot: null as Pilot | null }))
vi.mock('../src/workspaces/mimir/session', async (orig) => ({ ...(await orig<typeof import('../src/workspaces/mimir/session')>()), useTabMimir: () => tab.pilot }))

const { HostContext } = await import('../src/host')
const { set } = await import('../src/state/store')
const { MimirChat } = await import('../src/workspaces/mimir/mimir-panes')

// jsdom has no resize or intersection observers, scrolling or media queries; the chat uses them.
Element.prototype.scrollTo ??= () => undefined
Element.prototype.scrollIntoView ??= () => undefined
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof IntersectionObserver
if (!window.matchMedia) window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia

const host = { kind: 'web', capabilities: {}, build: { version: '1.0.0', commit: '0123456789abcdef', sourceUrl: 'https://example.test/src' }, slicer: {} } as unknown as Host

/** A tool that runs until the test lets it finish. */
function gatedTool(name: string) {
  let release: () => void = () => {}
  const started: string[] = []
  const finished: string[] = []
  const tool = defineTool<Record<string, never>>({
    name,
    version: '1',
    description: `Test tool ${name}`,
    source: 'skill',
    permission: 'read',
    input: z.object({}),
    async run() {
      started.push(name)
      await new Promise<void>((r) => (release = r))
      finished.push(name)
      return { summary: `${name} done` }
    },
  })
  return { tool, release: () => release(), started, finished }
}

const quick = (name: string, log: string[]) =>
  defineTool<Record<string, never>>({
    name,
    version: '1',
    description: `Test tool ${name}`,
    source: 'skill',
    permission: 'read',
    input: z.object({}),
    async run() {
      log.push(name)
      return { summary: `${name} done` }
    },
  })

/** One run the tab started: its session, its signal and the events the runtime sent for it. */
interface Started {
  sessionId: string
  signal: AbortSignal | undefined
  events: PilotEvent[]
}

/** Copies a run's events as the runtime sends them, ahead of the chat. */
async function* tap(it: AsyncIterable<PilotEvent>, into: PilotEvent[]): AsyncIterable<PilotEvent> {
  for await (const e of it) {
    into.push(e)
    yield e
  }
}

/** The tab's runtime over scripted steps, with every run and hold it gets recorded. */
function tabRuntime(steps: ScriptStep[], tools: unknown[]) {
  const printers = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
  const approvals = { register: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost
  const inner = createPilot({ host: { printers, approvals, llm: {} as LlmTransport }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: tools as never[] })
  const runs: Started[] = []
  const holds: [string, boolean][] = []
  const pilot: Pilot = {
    ...inner,
    run: (sessionId, message, opts) => {
      const r: Started = { sessionId, signal: opts?.signal, events: [] }
      runs.push(r)
      return tap(inner.run(sessionId, message, opts), r.events)
    },
    hold: (sessionId, on) => {
      holds.push([sessionId, on])
      inner.hold!(sessionId, on)
    },
  }
  return { pilot, runs, holds }
}

const types = (events: PilotEvent[], type: PilotEvent['type']) => events.filter((e) => e.type === type)
/**
 * Lets everything already queued run (promise jobs and zero-delay callbacks), so a check that something did not
 * happen sees whatever was going to happen next. No fixed wait.
 */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
  })

async function mount(pilot: Pilot) {
  tab.pilot = pilot
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => void render(createElement(QueryClientProvider, { client: queries }, createElement(HostContext.Provider, { value: host }, createElement(MimirChat)))))
  return { button: () => screen.getByTestId('mimir-pause') }
}

/** A message sent to the tab, the way Ask mimir in the command bar hands one over. */
const ask = (text: string) => act(() => set({ pilotPrompt: text }))

beforeEach(() => set({ workspace: 'prepare', modelMode: 'mimir', modelModeDefault: 'slice', devBuild: true, settingsMode: 'simple', pilot: { mode: 'off' }, pilotPrompt: null }))
afterEach(() => {
  cleanup()
  tab.pilot = null
})

describe('Pause and Resume in the tab header', () => {
  it('holds the run going, reads Resume while held, and Resume lets the same run go on', async () => {
    const a = gatedTool('a')
    const log: string[] = []
    const { pilot, runs, holds } = tabRuntime([{ calls: [{ name: 'a', args: {} }, { name: 'b', args: {} }] }, { text: 'All set.' }], [a.tool, quick('b', log)])
    const { button } = await mount(pilot)
    // no run going: off, and it says Pause
    expect(button().getAttribute('aria-disabled')).toBe('true')
    expect(button().getAttribute('aria-label')).toBe('Pause mimir')
    await ask('go')
    await waitFor(() => expect(a.started).toEqual(['a']))
    await waitFor(() => expect(button().getAttribute('aria-disabled')).toBeNull())
    expect(button().getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button())
    // the click holds this chat's run, and the label follows the hold
    expect(holds).toEqual([[runs[0]!.sessionId, true]])
    await waitFor(() => expect(button().getAttribute('aria-label')).toBe('Resume mimir'))
    expect(button().getAttribute('aria-pressed')).toBe('true')
    expect(button().getAttribute('data-tip-title')).toBe('Resume mimir')

    // the tool going finishes, and the run then waits before the next one
    a.release()
    await waitFor(() => expect(types(runs[0]!.events, 'tool_result')).toHaveLength(1))
    await settle()
    expect(log).toEqual([])
    expect(types(runs[0]!.events, 'done')).toEqual([])
    expect(button().getAttribute('aria-label')).toBe('Resume mimir')

    fireEvent.click(button())
    expect(holds).toEqual([
      [runs[0]!.sessionId, true],
      [runs[0]!.sessionId, false],
    ])
    // the same run goes on: b runs, and the run ends on its reply
    await waitFor(() => expect(types(runs[0]!.events, 'done')).toMatchObject([{ stopReason: 'end' }]))
    expect(log).toEqual(['b'])
    expect(runs).toHaveLength(1)
    expect(types(runs[0]!.events, 'start')).toHaveLength(1)
    await waitFor(() => expect(screen.getByTestId('mimir-transcript').textContent).toContain('All set.'))
    // with the run over the button is off again, and says Pause
    await waitFor(() => expect(button().getAttribute('aria-disabled')).toBe('true'))
    expect(button().getAttribute('aria-label')).toBe('Pause mimir')
    expect(button().getAttribute('aria-pressed')).toBe('false')
  })

  it('New conversation while held cancels the held run', async () => {
    const a = gatedTool('a')
    const log: string[] = []
    const { pilot, runs } = tabRuntime([{ calls: [{ name: 'a', args: {} }, { name: 'b', args: {} }] }, { text: 'Done.' }, { text: 'Hello again.' }], [a.tool, quick('b', log)])
    const { button } = await mount(pilot)
    await ask('go')
    await waitFor(() => expect(a.started).toEqual(['a']))
    await waitFor(() => expect(button().getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(button())
    await waitFor(() => expect(button().getAttribute('aria-label')).toBe('Resume mimir'))
    a.release()
    // the run is held at the boundary before b
    await waitFor(() => expect(types(runs[0]!.events, 'tool_result')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    // the old run is canceled, not left waiting: the runtime ends it as canceled and b never runs
    await waitFor(() => expect(runs[0]!.signal?.aborted).toBe(true))
    await waitFor(() => expect(types(runs[0]!.events, 'done')).toMatchObject([{ stopReason: 'canceled' }]))
    await settle()
    expect(log).toEqual([])
    expect(types(runs[0]!.events, 'tool_call').map((e) => (e as { tool: string }).tool)).toEqual(['a'])
    // the new chat is empty and not held
    await waitFor(() => expect(button().getAttribute('aria-label')).toBe('Pause mimir'))
    expect(button().getAttribute('aria-disabled')).toBe('true')
    expect(button().getAttribute('aria-pressed')).toBe('false')

    // its first message runs in the new session straight through
    await ask('hello')
    await waitFor(() => expect(runs).toHaveLength(2))
    expect(runs[1]!.sessionId).not.toBe(runs[0]!.sessionId)
    await waitFor(() => expect(types(runs[1]!.events, 'done')).toMatchObject([{ stopReason: 'end' }]))
    expect(types(runs[1]!.events, 'held')).toEqual([])
    expect(log).toEqual([])
  })
})
