// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab's message box under fast typing, in the real chat: keys land in bursts between renders with an empty
// chat, with a size sheet waiting, and while a sheet arrives mid-message, and a paste followed by more typing lands as
// one insert at the caret. Every character stays, in order, and focus never leaves the box.
import { DEFAULT_POLICY, type ApprovalHost, type Host, type LlmTransport, type Pilot, type PrinterHost } from '@slicerx/contracts'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, sheetTool, type ScriptStep } from '@slicerx/pilot'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tab = vi.hoisted(() => ({ pilot: null as Pilot | null }))
vi.mock('../src/workspaces/mimir/session', async (orig) => ({ ...(await orig<typeof import('../src/workspaces/mimir/session')>()), useTabMimir: () => tab.pilot }))

const { HostContext } = await import('../src/host')
const { set } = await import('../src/state/store')
const { MimirChat } = await import('../src/workspaces/mimir/mimir-panes')
const { setShownSheet, sheetMode, sheetUi } = await import('../src/workspaces/mimir/sheet-ui')

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
const PI = 'Design a Raspberry Pi 5 case: an open base with four standoffs for the board, cutouts for USB-C power, two micro HDMI ports, USB and Ethernet, side vents, and a snap-fit lid that prints flat beside it.'
const TWEAK = 'I want to tweak it so the lid opens out flat, with the vents a bit wider and 2 mm more room above the board.'

function runtime(steps: ScriptStep[]): Pilot {
  const printers = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
  const approvals = { register: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost
  return createPilot({ host: { printers, approvals, llm: {} as LlmTransport }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: true }), builtins: false, tools: [sheetTool()] })
}

async function mount(pilot: Pilot): Promise<HTMLTextAreaElement> {
  tab.pilot = pilot
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => void render(createElement(QueryClientProvider, { client: queries }, createElement(HostContext.Provider, { value: host }, createElement(MimirChat)))))
  return screen.getByTestId('mimir-composer').querySelector('textarea')!
}

const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

/** Puts `text` in at the caret the way the browser does, then sends its input event. */
function insert(box: HTMLTextAreaElement, text: string, inputType: 'insertText' | 'insertFromPaste'): void {
  const at = box.selectionStart
  setValue.call(box, box.value.slice(0, at) + text + box.value.slice(box.selectionEnd))
  box.setSelectionRange(at + text.length, at + text.length)
  box.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType }))
}

/**
 * Types `text` key by key into whatever has focus, as a fast typist does: keydown, the character, keyup, several keys
 * between two renders. Returns every place focus was not on the box.
 */
async function typeFast(box: HTMLTextAreaElement, text: string): Promise<string[]> {
  const away: string[] = []
  for (const [i, ch] of [...text].entries()) {
    const at = document.activeElement
    if (at !== box) away.push(`${i}: ${at?.tagName ?? 'none'}`)
    const target = (at ?? document.body) as HTMLElement
    const down = new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true })
    target.dispatchEvent(down)
    if (down.defaultPrevented) away.push(`${i}: key held back`)
    else if (target instanceof HTMLTextAreaElement) insert(target, ch, 'insertText')
    target.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }))
    if (i % 5 === 4) await tick()
  }
  await tick()
  return away
}

beforeEach(() => {
  set({ workspace: 'prepare', modelMode: 'mimir', modelModeDefault: 'slice', devBuild: true, settingsMode: 'simple', pilot: { mode: 'off' }, pilotPrompt: null })
})
afterEach(() => {
  cleanup()
  setShownSheet(null)
  tab.pilot = null
})

describe('the mimir message box under fast typing', () => {
  it('keeps every character of a long message in an empty chat', async () => {
    const box = await mount(runtime([{ text: 'On it.' }]))
    box.focus()
    expect(await typeFast(box, PI)).toEqual([])
    expect(box.value).toBe(PI)
  })

  it('keeps every character while a size sheet waits', async () => {
    const box = await mount(runtime([{ calls: [SHEET] }, { text: 'Adding the hole.' }]))
    await act(() => set({ pilotPrompt: 'a cable clip' }))
    await waitFor(() => expect(sheetMode(sheetUi.getState())).toBe('confirm'), { timeout: 5000 })
    box.focus()
    expect(await typeFast(box, TWEAK)).toEqual([])
    expect(box.value).toBe(TWEAK)
    expect(screen.getByTestId('mimir-composer').getAttribute('data-answers')).toBe('sheet')
  })

  it('keeps every character while a sheet arrives mid-message', async () => {
    const box = await mount(runtime([{ calls: [SHEET] }, { text: 'Adding the hole.' }]))
    box.focus()
    await act(() => set({ pilotPrompt: 'a cable clip' }))
    expect(await typeFast(box, PI)).toEqual([])
    expect(box.value).toBe(PI)
    // the sheet is up now, and the box still holds what was typed
    await waitFor(() => expect(sheetMode(sheetUi.getState())).toBe('confirm'), { timeout: 5000 })
    expect(box.value).toBe(PI)
  })

  it('takes a paste as pasted and keeps the keys typed after it', async () => {
    const box = await mount(runtime([{ text: 'On it.' }]))
    box.focus()
    act(() => insert(box, 'Lay the lid flat beside the base', 'insertFromPaste'))
    expect(await typeFast(box, ', roof down.')).toEqual([])
    expect(box.value).toBe('Lay the lid flat beside the base, roof down.')
  })
})
