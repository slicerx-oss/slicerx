// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab itself, rendered with a size sheet waiting and sizes typed on it: a client's mimir.dismiss (through the
// cards the chat registers) and Return in the message box both set the sheet aside through the one shared
// setSheetAside, so mimir hears of the typed sizes either way. The tests drive the real chat, not a copy of its wiring.
import { DEFAULT_POLICY, type ApprovalHost, type Host, type LlmTransport, type Pilot, type PrinterHost } from '@slicerx/contracts'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, sheetTool, type ScriptStep } from '@slicerx/pilot'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tab = vi.hoisted(() => ({ pilot: null as Pilot | null }))
vi.mock('../src/workspaces/mimir/session', async (orig) => ({ ...(await orig<typeof import('../src/workspaces/mimir/session')>()), useTabMimir: () => tab.pilot }))
// the shared set-aside, watched: both of the chat's paths must go through it
vi.mock('../src/workspaces/mimir/sheet-ui', async (orig) => {
  const real = await orig<typeof import('../src/workspaces/mimir/sheet-ui')>()
  return { ...real, setSheetAside: vi.fn(real.setSheetAside) }
})

const { HostContext } = await import('../src/host')
const { set } = await import('../src/state/store')
const { MimirChat } = await import('../src/workspaces/mimir/mimir-panes')
const { runCall } = await import('../src/app-link/methods')
const { setDraft, setSheetAside, setShownSheet, sheetMode, sheetUi } = await import('../src/workspaces/mimir/sheet-ui')

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
const SHEET = { name: 'pilot.sheet', args: { title: 'Clip sizes', dims: [{ key: 'bore', label: 'Cable bore', value: 6.2, unit: 'mm', source: 'asked' }] } }

/** The tab's runtime: one sheet, then a reply that reads the sheet's answer; every answerSheet call recorded. */
function tabRuntime() {
  const seen: unknown[] = []
  const reader: ScriptStep = (messages) => {
    const last = messages.at(-1)
    if (last?.role === 'tool') seen.push(JSON.parse(last.content))
    return { text: 'Adding the hole.' }
  }
  const printers = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
  const approvals = { register: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost
  const inner = createPilot({ host: { printers, approvals, llm: {} as LlmTransport }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient([{ calls: [SHEET] }, reader], { chunk: false }), builtins: false, tools: [sheetTool()] })
  const answered: [string, Record<string, number> | null, string | undefined][] = []
  const pilot: Pilot = {
    ...inner,
    answerSheet: (sheetId, values, said) => {
      answered.push([sheetId, values, said])
      return inner.answerSheet!(sheetId, values, said)
    },
  }
  return { pilot, answered, seen }
}

async function mount(pilot: Pilot) {
  tab.pilot = pilot
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => void render(createElement(QueryClientProvider, { client: queries }, createElement(HostContext.Provider, { value: host }, createElement(MimirChat)))))
}

/** Sends the first message, waits for the sheet to wait in the chat, then types a bore on it. */
async function sheetWaiting(bore: number): Promise<string> {
  await act(() => set({ pilotPrompt: 'a cable clip' }))
  await waitFor(() => expect(sheetMode(sheetUi.getState())).toBe('confirm'))
  const sheetId = sheetUi.getState().shown!.sheet.id
  act(() => setDraft('bore', bore))
  return sheetId
}

beforeEach(() => {
  set({ workspace: 'prepare', modelMode: 'mimir', modelModeDefault: 'slice', devBuild: true, settingsMode: 'simple', pilot: { mode: 'off' }, pilotPrompt: null })
  vi.mocked(setSheetAside).mockClear()
})
afterEach(() => {
  cleanup()
  setShownSheet(null)
  tab.pilot = null
})

describe('setting a waiting sheet aside from the mimir tab', () => {
  it('carries the typed sizes when a client sets it aside through the cards the chat registers', async () => {
    const t = tabRuntime()
    await mount(t.pilot)
    const sheetId = await sheetWaiting(7)
    await act(async () => void (await runCall('mimir.dismiss', { sheetId, said: 'and a cable hole' })))
    expect(vi.mocked(setSheetAside)).toHaveBeenCalledWith(t.pilot, sheetId, 'and a cable hole')
    expect(t.answered).toEqual([[sheetId, { bore: 7 }, 'and a cable hole']])
    await waitFor(() => expect(t.seen).toHaveLength(1))
    expect(t.seen[0]).toMatchObject({ result: { confirmed: false, said: 'and a cable hole', values: { bore: 7 }, changed: ['bore'] } })
  })

  it('carries the typed sizes when the person writes in the message box while it waits', async () => {
    const t = tabRuntime()
    await mount(t.pilot)
    const sheetId = await sheetWaiting(8)
    const box = screen.getByTestId('mimir-composer').querySelector('textarea')!
    await waitFor(() => expect(screen.getByTestId('mimir-composer').getAttribute('data-answers')).toBe('sheet'))
    fireEvent.change(box, { target: { value: 'make it a clip for two cables' } })
    await act(async () => void fireEvent.keyDown(box, { key: 'Enter' }))
    expect(vi.mocked(setSheetAside)).toHaveBeenCalledWith(t.pilot, sheetId, 'make it a clip for two cables')
    expect(t.answered).toEqual([[sheetId, { bore: 8 }, 'make it a clip for two cables']])
    await waitFor(() => expect(t.seen).toHaveLength(1))
    expect(t.seen[0]).toMatchObject({ result: { confirmed: false, said: 'make it a clip for two cables', values: { bore: 8 }, changed: ['bore'] } })
  })
})
