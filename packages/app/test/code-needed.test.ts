// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer whose access code was kept only for the last session (the system keychain refused it): its
// card asks for the code once, plainly, instead of showing a failed connection, and saves it like setup does.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeNeeded } from '../src/features/fleet/offline'
import { HostContext } from '../src/host'
import { get, set } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(kept: 'stored' | 'session') {
  const saved: [string, string][] = []
  const host = { kind: 'desktop', capabilities: {}, secrets: { has: async () => false, set: async (n: string, v: string) => (saved.push([n, v]), { kept }), delete: async () => undefined } }
  const qc = new QueryClient()
  let refetched = 0
  qc.getQueryCache().subscribe((e) => {
    if (e.type === 'updated' && e.action.type === 'invalidate') refetched++
  })
  qc.setQueryData(['fleet', 0], [])
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(HostContext.Provider, { value: host as never }, createElement(CodeNeeded, { codeRef: 'printer-p1s', name: 'P1S' })))))
  return { el, saved, refetched: () => refetched, done: () => act(() => root.unmount()) }
}

async function enter(el: HTMLElement, code: string) {
  const input = el.querySelector('input') as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, code)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    ;(el.querySelector('form') as HTMLFormElement).requestSubmit()
  })
}

afterEach(() => {
  set({ toast: null })
  document.body.innerHTML = ''
})

describe('a printer whose access code is gone', () => {
  it('asks for the code in plain words, not as a failed connection', () => {
    const r = render('stored')
    expect(r.el.textContent).toMatch(/access code/i)
    expect(r.el.textContent).not.toMatch(/not reachable|did not answer/i)
    const input = r.el.querySelector('input')!
    expect(input.type).toBe('password')
    r.done()
  })

  it('stores the code under the printer\'s name and checks the printer again', async () => {
    const r = render('stored')
    await enter(r.el, '12345678')
    expect(r.saved).toEqual([['printer-p1s', '12345678']])
    expect(r.refetched()).toBeGreaterThan(0)
    expect(get().toast).toBeNull()
    r.done()
  })

  it('says so when the keychain keeps it only until the app closes', async () => {
    const r = render('session')
    await enter(r.el, '12345678')
    expect(get().toast?.tone).toBe('warn')
    expect(get().toast?.text).toMatch(/until .* closes/i)
    r.done()
  })
})
