// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The command bar while its search results are still downloading (moved from the command-load Playwright spec, which
// held the real chunk): typing and reopening stay usable, Enter before the results arrive runs the typed command
// once they do, and editing the query cancels that Enter.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The results module is a dynamic import in the bar. Its factory waits on this gate, so the import stays pending
// until a test lets it through, as a slow chunk does. Each test gets a new gate and fresh modules, since a module
// that has loaded once stays loaded.
const gate = vi.hoisted(() => ({ open: Promise.resolve(), release: () => {} }))
vi.mock('../src/shell/command-results', async (importOriginal) => {
  await gate.open
  return importOriginal<typeof import('../src/shell/command-results')>()
})
// The bar reads the printer list only to feed the results; there is no hub here.
vi.mock('../src/lib/queries', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/queries')>()), useFleetPick: () => [] }))

let runs: string[] = []
let off: () => void = () => {}
let store: typeof import('../src/state/store')
let CommandBar: typeof import('../src/shell/command-bar').CommandBar

beforeEach(async () => {
  gate.open = new Promise<void>((resolve) => (gate.release = resolve))
  vi.resetModules()
  store = await import('../src/state/store')
  ;({ CommandBar } = await import('../src/shell/command-bar'))
  const { registerCommands } = await import('../src/commands/registry')
  runs = []
  const cmd = (id: string, title: string, keywords: string[]) => ({ id, title, keywords, section: 'plate' as const, run: () => void runs.push(id) })
  off = registerCommands([cmd('test.clone', 'Duplicate the selected objects', ['clone']), cmd('test.copy', 'Copy to clipboard', ['copy'])])
  store.set({ commandOpen: true })
})

// The bar loads search, settings and presets in the background; the file must not end while they are still loading.
afterEach(async () => {
  cleanup()
  off()
  await vi.dynamicImportSettled()
})

const input = () => screen.getByRole('combobox') as HTMLInputElement
const type = (value: string) => act(() => void fireEvent.change(input(), { target: { value } }))
const key = (k: string) => act(() => void fireEvent.keyDown(input(), { key: k }))
const row = (title: RegExp) => screen.getByRole('option', { name: title })

describe('the command bar while search downloads', () => {
  it('keeps typing and reopening usable, then lists the results when they arrive', async () => {
    render(createElement(CommandBar))
    expect(document.activeElement).toBe(input())
    type('clone')
    expect(input().value).toBe('clone')
    // Nothing to list yet, and Enter with no row runs nothing.
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    key('Enter')
    key('Escape')
    expect(store.get().commandOpen).toBe(false)
    expect(screen.queryByRole('combobox')).toBeNull()
    // Reopened: focused and empty, not holding the old query.
    act(() => store.set({ commandOpen: true }))
    expect(document.activeElement).toBe(input())
    expect(input().value).toBe('')
    type('clone')
    await act(async () => gate.release())
    await waitFor(() => expect(row(/Duplicate the selected objects/)).toBeTruthy())
    expect(input().value).toBe('clone')
    expect(document.activeElement).toBe(input())
    // The Enter pressed before the results was dropped with the close; this one runs the row.
    expect(runs).toEqual([])
    key('Enter')
    await waitFor(() => expect(runs).toEqual(['test.clone']))
    expect(store.get().commandOpen).toBe(false)
  })

  it('runs the typed command once, after the results arrive, when Enter came first', async () => {
    render(createElement(CommandBar))
    type('clone')
    key('Enter')
    expect(runs).toEqual([])
    expect(store.get().commandOpen).toBe(true)
    await act(async () => gate.release())
    await waitFor(() => expect(runs).toEqual(['test.clone']))
    expect(store.get().commandOpen).toBe(false)
  })

  it('drops that Enter when the query is edited before the results arrive', async () => {
    render(createElement(CommandBar))
    type('clone')
    key('Enter')
    type('copy')
    await act(async () => gate.release())
    await waitFor(() => expect(row(/Copy to clipboard/)).toBeTruthy())
    expect(input().value).toBe('copy')
    expect(document.activeElement).toBe(input())
    expect(runs).toEqual([])
    expect(store.get().commandOpen).toBe(true)
  })
})
