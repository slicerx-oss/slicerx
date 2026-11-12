// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab follows a reply while the reader is at the end of the chat. A button pressed in the chat while the
// reply is going (a question card's answer) stops that, so the reply it starts appears under the card and the card
// stays where it was pressed, until the reply puts up a new card for the person. jsdom lays nothing out, so the chat's
// heights are stubbed from what it holds.
import { DEFAULT_POLICY, type ApprovalHost, type Host, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { askTool, createPilot, createScriptedClient, DEFAULT_CONFIG, sheetTool, type ScriptStep } from '@slicerx/pilot'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pilot } from '@slicerx/contracts'

const tab = vi.hoisted(() => ({ pilot: null as Pilot | null }))
vi.mock('../src/workspaces/mimir/session', async (orig) => ({ ...(await orig<typeof import('../src/workspaces/mimir/session')>()), useTabMimir: () => tab.pilot }))

const { HostContext } = await import('../src/host')
const { set } = await import('../src/state/store')
const { chatPill, MimirChat, pressHoldsChat } = await import('../src/workspaces/mimir/mimir-panes')

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
const SHEET = { name: 'pilot.sheet', args: { title: 'Mount sizes', fits: true, dims: [{ key: 'lip', label: 'Lip', value: 3, unit: 'mm', source: 'guess' }] } }
const ASK = { name: 'pilot.ask', args: { title: 'Which model?', question: 'Is it the round one?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'No, another' }] } }

function tabRuntime(after: ScriptStep = { text: 'Looking up its size. It is about 80 mm across, so the mount gets a lip of 3 mm all round.' }): Pilot {
  const printers = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
  const approvals = { register: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost
  const client = createScriptedClient([{ calls: [ASK] }, after, { text: 'Building it.' }], { chunk: false })
  return createPilot({ host: { printers, approvals, llm: {} as LlmTransport }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client, builtins: false, tools: [askTool(), sheetTool()] })
}

/** The chat 200 px tall, its content as tall as its text, and a scroll position that keeps what it is given. */
function layOut(log: HTMLElement): void {
  let top = 0
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 200 })
  Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => Math.max(200, (log.textContent ?? '').length * 4) })
  Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = Math.max(0, Math.min(v, log.scrollHeight - log.clientHeight))) })
}

beforeEach(() => set({ workspace: 'prepare', modelMode: 'mimir', modelModeDefault: 'slice', devBuild: true, settingsMode: 'simple', pilot: { mode: 'off' }, pilotPrompt: null }))
afterEach(() => {
  cleanup()
  tab.pilot = null
})

describe('a press in the mimir chat', () => {
  /** The tab with a question card waiting at the end of the chat, followed there; the chat and the card's chip. */
  async function cardAtEnd(after?: ScriptStep): Promise<{ log: HTMLElement; chip: HTMLElement }> {
    tab.pilot = tabRuntime(after)
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => void render(createElement(QueryClientProvider, { client: queries }, createElement(HostContext.Provider, { value: host }, createElement(MimirChat)))))
    const log = screen.getByTestId('mimir-transcript')
    layOut(log)
    await act(() => set({ pilotPrompt: 'a wall mount for my thermostat' }))
    const chip = await screen.findByRole('button', { name: 'Yes, that one' }, { timeout: 5000 })
    await waitFor(() => expect(log.scrollTop).toBe(log.scrollHeight - log.clientHeight))
    return { log, chip }
  }

  it('keeps a question card where it was pressed while the reply it starts comes in under it', async () => {
    const { log, chip } = await cardAtEnd()
    const at = log.scrollTop
    fireEvent.pointerDown(chip)
    fireEvent.click(chip)
    await waitFor(() => expect(log.textContent).toContain('the mount gets a lip of 3 mm'), { timeout: 5000 })
    // the reply made the chat taller, and the card did not move for it
    expect(log.scrollHeight - log.clientHeight).toBeGreaterThan(at)
    expect(log.scrollTop).toBe(at)
  })

  it('says a reply goes on under the fold, and its pill takes the reader to the end and follows again', async () => {
    const { log, chip } = await cardAtEnd()
    expect(screen.queryByTestId('mimir-reply-pill')).toBeNull()
    const at = log.scrollTop
    fireEvent.pointerDown(chip)
    fireEvent.click(chip)
    const pill = await screen.findByTestId('mimir-reply-pill', {}, { timeout: 5000 })
    expect(pill.textContent).toBe('New reply below')
    expect(log.scrollTop).toBe(at)
    fireEvent.click(pill)
    expect(log.scrollTop).toBe(log.scrollHeight - log.clientHeight)
    await waitFor(() => expect(screen.queryByTestId('mimir-reply-pill')).toBeNull())
  })

  it('drops the pill once the reader scrolls to the end', async () => {
    const { log, chip } = await cardAtEnd()
    fireEvent.pointerDown(chip)
    fireEvent.click(chip)
    await screen.findByTestId('mimir-reply-pill', {}, { timeout: 5000 })
    log.scrollTop = log.scrollHeight
    fireEvent.scroll(log)
    await waitFor(() => expect(screen.queryByTestId('mimir-reply-pill')).toBeNull())
  })

  it('shows no pill for a press while nothing is below the fold', async () => {
    const { log, chip } = await cardAtEnd({ text: 'Ok.' })
    // a chat taller than its content: the short reply fits under the card
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 200 })
    fireEvent.pointerDown(chip)
    fireEvent.click(chip)
    await waitFor(() => expect(log.textContent).toContain('Ok.'), { timeout: 5000 })
    expect(screen.queryByTestId('mimir-reply-pill')).toBeNull()
  })

  it('goes on to the next card the reply puts up for the person', async () => {
    const { log, chip } = await cardAtEnd({ text: 'Looking up its size. It is about 80 mm across, so here are the sizes to check.', calls: [SHEET] })
    const at = log.scrollTop
    fireEvent.pointerDown(chip)
    fireEvent.click(chip)
    await screen.findByTestId('mimir-sheet-record', {}, { timeout: 5000 })
    // the sheet waits at the end of the chat, and the chat is there with it
    await waitFor(() => expect(log.scrollTop).toBe(log.scrollHeight - log.clientHeight))
    expect(log.scrollTop).toBeGreaterThan(at)
  })

  it('leaves the foot of the chat to the Sizes pill while a sheet waits out of view', () => {
    expect(chatPill(true, true)).toBe('sizes')
    expect(chatPill(true, false)).toBe('sizes')
    expect(chatPill(false, true)).toBe('reply')
    expect(chatPill(false, false)).toBeNull()
  })

  it('holds the chat only for a button pressed while a reply is going', () => {
    const card = document.createElement('div')
    card.innerHTML = '<button type="button"><span>Yes</span></button><button type="button" disabled>Cancel</button><p>text</p>'
    const [yes, cancel] = Array.from(card.querySelectorAll('button'))
    expect(pressHoldsChat(yes!.firstElementChild, true)).toBe(true)
    expect(pressHoldsChat(yes!, false)).toBe(false)
    expect(pressHoldsChat(cancel!, true)).toBe(false)
    expect(pressHoldsChat(card.querySelector('p'), true)).toBe(false)
    expect(pressHoldsChat(null, true)).toBe(false)
  })
})
