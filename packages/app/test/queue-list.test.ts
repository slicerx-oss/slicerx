// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The queue on Printers (moved from plate.spec.ts): it lists the waiting plates, marks a due one Ready, makes a later
// plate on the same printer wait for the first, starts through the approval flow, and removes an item. The due and
// order rules are in queue.test.ts; the bed-clear question is the approval dialog's (approval-dialog.tsx).
import type { FleetRow } from '../src/lib/queries'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostContext } from '../src/host'
import type { QueueItem } from '../src/queue/queue'

const started = vi.hoisted(() => [] as string[])
vi.mock('../src/state/actions', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/state/actions')>()), startQueued: async (_host: unknown, item: { plateName: string }) => void started.push(item.plateName) }))

const item = (id: string, startAfter?: string): QueueItem => ({
  id,
  printerId: 'bay-2',
  printerName: 'Bay 2',
  plateName: id,
  remote: { printerId: 'bay-2', path: `/${id}.gcode`, name: `${id}.gcode` },
  sha256: 'abcdef0123456789',
  layers: 120,
  timeS: 3600,
  grams: 12,
  options: {},
  ...(startAfter ? { startAfter } : {}),
  addedAt: '2026-09-30T10:00:00.000Z',
})

const rows = [{ id: 'bay-2', status: { state: 'idle' } }] as unknown as FleetRow[]

beforeEach(() => {
  document.body.replaceChildren()
  started.length = 0
})

describe('the queue list', () => {
  it('lists the plates, marks a due one, holds the second on a printer, starts through the flow, and removes', async () => {
    const { QueuedList } = await import('../src/features/fleet/fleet')
    const { set, get } = await import('../src/state/store')
    set({ queue: [item('Bracket', '2020-01-01T00:00:00.000Z'), item('Lid')] })
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    const host = { kind: 'web', capabilities: {} } as never
    flushSync(() => root.render(createElement(HostContext.Provider, { value: host }, createElement(QueuedList, { rows }))))
    const list = () => [...el.querySelectorAll('ul[aria-label="Queued plates"] > li')]
    expect(list()).toHaveLength(2)
    expect(list()[0]!.textContent).toContain('Ready')
    expect(list()[1]!.textContent).not.toContain('Ready')
    const start = (i: number) => [...list()[i]!.querySelectorAll('button')].find((b) => b.textContent === 'Start')!
    // The second plate on the same printer waits for the first.
    expect(start(1).disabled || start(1).getAttribute('aria-disabled') === 'true').toBe(true)
    flushSync(() => start(0).click())
    await vi.waitFor(() => expect(started).toEqual(['Bracket']))
    flushSync(() => (list()[0]!.querySelector('button[aria-label="Remove Bracket from the queue"]') as HTMLButtonElement).click())
    expect(get().queue.map((q) => q.id)).toEqual(['Lid'])
    root.unmount()
    el.remove()
  })
})
