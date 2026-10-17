// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The desktop app starts its own printer bridge. When another program holds its port the start fails with the
// shell's own words, and the person sees them on the Printers page, where they went to use a printer, and again in
// Settings > Printer bridge. Try again starts the bridge once more. (Moved from the bridge-port Playwright spec, whose
// page stood in for the shell; the shell's rejection reaches the status unchanged, which the first test shows.)
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '@slicerx/contracts'

const { HostContext } = await import('../src/host')
const { FeaturesContext } = await import('../src/features')
const { Fleet } = await import('../src/features/fleet/fleet')
const { BridgeSection } = await import('../src/link/section')
const { connectBridge, resetBridge, setBridgeConnector } = await import('../src/link/bridge')
const { get, set } = await import('../src/state/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// What apps/desktop/src-tauri/src/link.rs says for a port in use. A Tauri command rejects with a string.
const TAKEN = 'Port 47615 is in use by another program, so the printer bridge did not start. Close that program, such as an sx-link left running, then try again.'

let starts = 0
let root: Root
let el: HTMLDivElement

const host = {
  kind: 'web',
  capabilities: {},
  printers: { list: async () => [], status: async () => ({}), subscribe: () => () => undefined, snapshot: async () => null, fleets: async () => [] },
} as unknown as Host

beforeEach(() => {
  resetBridge()
  starts = 0
  // The desktop connector: automatic, and its start rejects with the shell's string.
  setBridgeConnector({ automatic: true, connect: async () => { starts++; throw TAKEN } })
  set({ bridgeStatus: { state: 'off' } })
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})

// connectBridge and the Printers page load modules in the background; the file must not end while they are loading.
afterEach(async () => {
  act(() => root.unmount())
  el.remove()
  resetBridge()
  set({ bridgeStatus: { state: 'off' } })
  await vi.dynamicImportSettled()
})

async function show(child: ReturnType<typeof createElement>): Promise<void> {
  const features = { ids: new Set(['connect']), features: [], workspaces: [], settings: [] } as never
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(FeaturesContext.Provider, { value: features }, createElement(HostContext.Provider, { value: host as never }, child))))
  })
  await act(async () => new Promise<void>((r) => setTimeout(r, 20)))
}

describe('a taken bridge port', () => {
  it('reaches the status in the shell\'s own words', async () => {
    expect(await connectBridge(host)).toBe(false)
    expect(get().bridgeStatus).toEqual({ state: 'error', message: TAKEN })
  })

  it('is said on the Printers page, with a way to try again that starts the bridge once more', async () => {
    await connectBridge(host)
    await show(createElement(Fleet))
    const note = el.querySelector<HTMLElement>('[data-testid="bridge-error"]')!
    expect(note.textContent).toContain(TAKEN)
    expect(starts).toBe(1)
    const again = [...note.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!
    await act(async () => again.click())
    await act(async () => new Promise<void>((r) => setTimeout(r, 20)))
    expect(starts).toBe(2)
    // The port is still taken, so the note stays.
    expect(el.querySelector('[data-testid="bridge-error"]')?.textContent).toContain(TAKEN)
  })

  it('is said in Settings > Printer bridge in the same words', async () => {
    await connectBridge(host)
    await show(createElement(BridgeSection))
    const section = el.querySelector('#bridge-h')!.parentElement!
    expect(section.querySelector('[role="alert"]')?.textContent).toBe(TAKEN)
  })

  it('is not shown on the Printers page for a bridge the person starts themselves', async () => {
    setBridgeConnector({ automatic: false, url: 'http://127.0.0.1:47615', connect: async () => { throw TAKEN } } as never)
    await connectBridge(host, 'ABCD1234')
    await show(createElement(Fleet))
    expect(el.querySelector('[data-testid="bridge-error"]')).toBeNull()
  })
})
