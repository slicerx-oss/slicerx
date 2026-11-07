// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cmd+K before the command bar's code has downloaded, as on a slow machine: the palette is up in the same frame with its
// input focused, what is typed and the Enter after it are kept, and the real bar runs the match once, when it is there.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The bar's own module is a dynamic import in the slot. One of its imports (the id of the assistant row, which nothing
// else loads first) waits on this gate, so the import stays pending until a test lets it through, as a slow chunk does.
// The settings the bar also searches come in their own chunk, and load at once unless a test holds them back. Each
// test gets new gates, fresh modules and fresh mocks: a vi.mock factory runs once per file, so only the first test
// would wait.
const gate = { open: Promise.resolve(), release: () => {} }
const settingsGate = { open: Promise.resolve(), release: () => {} }
vi.mock('../src/lib/queries', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/queries')>()), useFleetPick: () => [] }))

let runs: string[] = []
let off: () => void = () => {}
let store: typeof import('../src/state/store')
let CommandBarSlot: typeof import('../src/shell/command-bar-slot').CommandBarSlot

beforeEach(async () => {
  // jsdom does not scroll.
  Element.prototype.scrollIntoView = () => {}
  gate.open = new Promise<void>((resolve) => (gate.release = resolve))
  settingsGate.open = Promise.resolve()
  vi.resetModules()
  vi.doMock('../src/shell/command-bar-id', async () => {
    await gate.open
    return { ASK: 'pilot-ask' }
  })
  vi.doMock('../src/adapters/settings', async (importOriginal) => {
    await settingsGate.open
    return importOriginal<typeof import('../src/adapters/settings')>()
  })
  store = await import('../src/state/store')
  ;({ CommandBarSlot } = await import('../src/shell/command-bar-slot'))
  const { registerCommands } = await import('../src/commands/registry')
  runs = []
  const cmd = (id: string, title: string, keywords: string[]) => ({ id, title, keywords, section: 'plate' as const, run: () => void runs.push(id) })
  off = registerCommands([cmd('test.open', 'Open a model file', ['open']), cmd('test.copy', 'Copy to clipboard', ['copy'])])
  render(createElement(CommandBarSlot))
})

afterEach(async () => {
  cleanup()
  off()
  // A test that stopped before the code arrived must not leave the import waiting.
  gate.release()
  settingsGate.release()
  await vi.dynamicImportSettled()
})

const input = () => screen.getByRole('combobox') as HTMLInputElement
const type = (value: string) => act(() => void fireEvent.change(input(), { target: { value } }))
const key = (k: string) => act(() => void fireEvent.keyDown(input(), { key: k }))
const openBar = () => act(() => store.set({ commandOpen: true }))
const load = () => act(async () => gate.release())
// Lets every chunk the bar asked for (its results, the settings) arrive, so a waiting Enter would have run by now.
const settle = () => act(async () => { await vi.dynamicImportSettled(); await new Promise((r) => setTimeout(r, 50)) })

describe('the command bar opened before its code has downloaded', () => {
  it('has a focused input in the same frame as the key', () => {
    openBar()
    expect(document.activeElement).toBe(input())
    expect(screen.getByText('Loading commands')).toBeTruthy()
  })

  it('runs a command typed and entered at once, one time, when the code arrives', async () => {
    openBar()
    type('open')
    key('Enter')
    expect(runs).toEqual([])
    expect(store.get().commandOpen).toBe(true)
    await load()
    await waitFor(() => expect(runs).toEqual(['test.open']))
    expect(store.get().commandOpen).toBe(false)
    // Nothing queues it again when the bar settles or opens again.
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    openBar()
    await waitFor(() => expect(input().value).toBe(''))
    expect(runs).toEqual(['test.open'])
  })

  it('keeps what was typed in the real bar, with the focus', async () => {
    openBar()
    type('cop')
    await load()
    await waitFor(() => expect(screen.getByRole('option', { name: /Copy to clipboard/ })).toBeTruthy())
    expect(input().value).toBe('cop')
    expect(document.activeElement).toBe(input())
    expect(runs).toEqual([])
  })

  it('uses the query as it stands when the list is there', async () => {
    openBar()
    type('copy')
    type('open')
    key('Enter')
    await load()
    await waitFor(() => expect(runs).toEqual(['test.open']))
  })

  it('says so when nothing matches, and runs nothing', async () => {
    openBar()
    type('zzzz')
    key('Enter')
    await load()
    await waitFor(() => expect(screen.getByText('No command matches "zzzz"')).toBeTruthy())
    expect(runs).toEqual([])
    expect(store.get().commandOpen).toBe(true)
  })

  it('drops the Enter when the text is edited before the code arrives', async () => {
    openBar()
    type('open')
    key('Enter')
    // Deleting a letter is an edit too: the person changed their mind, so the bar waits for a new Enter.
    type('ope')
    expect(screen.getByText('Loading commands')).toBeTruthy()
    type('copy')
    await load()
    await waitFor(() => expect(screen.getByRole('option', { name: /Copy to clipboard/ })).toBeTruthy())
    await settle()
    expect(runs).toEqual([])
    expect(input().value).toBe('copy')
    expect(store.get().commandOpen).toBe(true)
  })

  it('runs the new text once when Enter comes again after the edit', async () => {
    openBar()
    type('copy')
    key('Enter')
    type('open')
    key('Enter')
    await load()
    await waitFor(() => expect(runs).toEqual(['test.open']))
    await settle()
    expect(runs).toEqual(['test.open'])
  })

  it('says it is loading until the settings are there too, then that nothing matches', async () => {
    settingsGate.open = new Promise<void>((resolve) => (settingsGate.release = resolve))
    openBar()
    type('zzzz')
    key('Enter')
    await load()
    // The commands are listed (the footer counts them), but a setting could still match, so the Enter still waits.
    await waitFor(() => expect(screen.getByText(/of \d+ commands/)).toBeTruthy())
    expect(screen.getByText('Loading commands')).toBeTruthy()
    expect(screen.queryByText(/No command matches/)).toBeNull()
    await act(async () => settingsGate.release())
    await waitFor(() => expect(screen.getByText('No command matches "zzzz"')).toBeTruthy())
    expect(runs).toEqual([])
  })

  it('drops the Enter when the bar is closed before the code arrives', async () => {
    openBar()
    type('open')
    key('Enter')
    key('Escape')
    expect(store.get().commandOpen).toBe(false)
    await load()
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    expect(runs).toEqual([])
    openBar()
    await waitFor(() => expect(input().value).toBe(''))
    expect(runs).toEqual([])
  })
})
