// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The toast card after a hub card the person approved here: when the hub then refuses the work, the refusal takes the
// place of that card's "Approved." line, so no check mark and no "Approved." sit beside "was not set".
import type { ApprovalRequest } from '@slicerx/contracts'
import { ToastProvider } from '@slicerx/ui'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { watchHubCards, type CardDone, type HubCard, type HubCards } from '../src/link/agent-cards'
import { ToastBridge } from '../src/shell/overlays'
import { set } from '../src/state/store'

const setting = { slot: 'A2', filamentId: 'GFG99', material: 'PETG', color: '#1A2B3C', nozzleTempMin: 220, nozzleTempMax: 260 }
const card = (id: string, over: Partial<HubCard> = {}): HubCard =>
  ({
    id,
    sessionId: 's',
    tool: 'printer.set_slot',
    permission: 'start',
    title: 'Set slot A2 on Bay 4 to PETG?',
    lines: [],
    origin: 'mcp',
    partner: 'LayerMate',
    paramsHash: 'h',
    actions: [{ action: 'printer.adjust', target: 'bay-4', paramsHash: 'a' }],
    work: { kind: 'slot', printerId: 'bay-4', setting },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...over,
  }) as HubCard
const pause = (id: string) => card(id, { actions: [{ action: 'printer.pause', target: 'bay-4', paramsHash: 'p' }], work: { kind: 'pause', printerId: 'bay-4' } })
const token = { requestId: 'x', token: 't', expiresAt: new Date(Date.now() + 300_000).toISOString() }
const names = (id: string) => (id === 'bay-4' ? 'Bay 4' : id)

function fakeHub(opts: { hold?: boolean } = {}) {
  let emit: (r: ApprovalRequest) => void = () => undefined
  let done: (d: CardDone) => void = () => undefined
  let release: () => void = () => undefined
  const hub: HubCards = {
    onRequest: (cb) => ((emit = cb), () => undefined),
    onDone: (cb) => ((done = cb), () => undefined),
    grantWith: () => (opts.hold ? new Promise((r) => (release = () => r(token))) : Promise.resolve(token)),
    deny: async () => undefined,
  }
  return { hub, emit: (r: ApprovalRequest) => emit(r), done: (d: CardDone) => done(d), release: () => release() }
}

/** The toast card's lines as drawn: text and tone of each. */
const lines = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-testid="toast"]')].map((t) => ({ text: t.textContent ?? '', tone: t.dataset['tone'] }))

/** Approves the open card as the dialog's Approve button does. */
async function approve() {
  const { get } = await import('../src/state/store')
  await act(async () => {
    await get().approval!.approve()
  })
}

describe('the toast card after a refused hub card', () => {
  beforeEach(() => set({ approval: null, toast: null }))
  afterEach(() => cleanup())

  it('replaces the card\'s "Approved." line with the refusal, in the error tone only', async () => {
    const { container } = render(createElement(ToastProvider, null, createElement(ToastBridge)))
    const h = fakeHub()
    const stop = watchHubCards(h.hub, names)
    act(() => h.emit(card('s-1')))
    await approve()
    expect(lines(container).map((l) => l.text).join(' ')).toContain('Approved.')
    act(() => h.done({ requestId: 's-1', printerId: 'bay-4', ok: false, code: 'bad_state' }))
    const now = lines(container)
    expect(now).toHaveLength(1)
    expect(now[0]!.text).toContain('Bay 4 is printing, so slot A2 was not set.')
    expect(now[0]!.tone).toBe('error')
    expect(now.map((l) => l.text).join(' ')).not.toContain('Approved')
    expect(container.querySelector('[data-testid="toast"][data-tone="ok"]')).toBeNull()
    expect(container.querySelector('[data-testid="toast-close"]')).not.toBeNull()
    stop()
  })

  it('takes away only the refused card\'s "Approved." line', async () => {
    const { container } = render(createElement(ToastProvider, null, createElement(ToastBridge)))
    const h = fakeHub()
    const stop = watchHubCards(h.hub, names)
    act(() => {
      h.emit(pause('p-1'))
      h.emit(pause('p-2'))
    })
    await approve()
    await approve()
    expect(lines(container).filter((l) => l.tone === 'ok')).toHaveLength(2)
    act(() => h.done({ requestId: 'p-1', printerId: 'bay-4', ok: false, code: 'bad_state' }))
    const now = lines(container)
    expect(now.filter((l) => l.tone === 'ok')).toHaveLength(1)
    expect(now.filter((l) => l.tone === 'error').map((l) => l.text)).toEqual([expect.stringContaining('Bay 4 is not printing, so the print was not paused.')])
    stop()
  })

  it('keeps the "Approved." line when the hub carries the work out', async () => {
    const { container } = render(createElement(ToastProvider, null, createElement(ToastBridge)))
    const h = fakeHub()
    const stop = watchHubCards(h.hub, names)
    act(() => h.emit(card('s-1')))
    await approve()
    act(() => h.done({ requestId: 's-1', printerId: 'bay-4', ok: true }))
    expect(lines(container)).toEqual([expect.objectContaining({ tone: 'ok' })])
    stop()
  })

  it('shows no "Approved." when the refusal comes before the grant answers', async () => {
    const { container } = render(createElement(ToastProvider, null, createElement(ToastBridge)))
    const h = fakeHub({ hold: true })
    const stop = watchHubCards(h.hub, names)
    act(() => h.emit(card('s-1')))
    const { get } = await import('../src/state/store')
    let approving: Promise<void> = Promise.resolve()
    act(() => void (approving = get().approval!.approve()))
    act(() => h.done({ requestId: 's-1', printerId: 'bay-4', ok: false, code: 'bad_state' }))
    await act(async () => {
      h.release()
      await approving
    })
    const now = lines(container)
    expect(now).toHaveLength(1)
    expect(now[0]!.tone).toBe('error')
    stop()
  })
})
