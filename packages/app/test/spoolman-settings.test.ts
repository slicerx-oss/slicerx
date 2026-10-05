// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { Host } from '@slicerx/contracts'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { HostContext } from '../src/host'
import { SpoolmanRows, spoolmanUrl } from '../src/inventory/spoolman-settings'
import type { BridgeServices } from '../src/link/bridge'
import { get, set } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Spoolman address', () => {
  it('fills in http:// and the port 7912', () => {
    expect(spoolmanUrl('192.168.1.50')).toEqual({ url: 'http://192.168.1.50:7912' })
    expect(spoolmanUrl(' spoolman.local:8000/ ')).toEqual({ url: 'http://spoolman.local:8000' })
    expect(spoolmanUrl('http://10.0.0.4:7912')).toEqual({ url: 'http://10.0.0.4:7912' })
  })

  it('refuses https, a path and an empty field', () => {
    expect(spoolmanUrl('https://10.0.0.4:7912')).toEqual({ error: expect.stringMatching(/plain http/) })
    expect(spoolmanUrl('10.0.0.4:7912/api/v1')).toEqual({ error: expect.stringMatching(/without a path/) })
    expect(spoolmanUrl('  ')).toEqual({ error: expect.stringMatching(/Type the address/) })
  })
})

function fakeServices() {
  const saved = new Map<string, string>()
  const services: BridgeServices = {
    list: async () => [...saved].map(([pluginId, baseUrl]) => ({ pluginId, baseUrl, hasSecret: false })),
    configure: async (id, url) => void saved.set(id, url),
    remove: async (id) => saved.delete(id),
  }
  const spools = [{ id: 1, material: 'PLA', vendor: 'Acme', name: 'Black', color: '#000000', remainingG: 640, initialG: 1000 }]
  const host = { printers: { callTool: vi.fn(async () => (saved.has('spoolman') ? spools : Promise.reject(new Error('spoolman is not configured')))) } } as unknown as Host
  return { services, host, saved }
}

const type = (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === text)!

describe('Spoolman in Settings', () => {
  it('adds the server, tests it, loads the spools and removes it', async () => {
    set({ spools: null })
    const { services, host, saved } = fakeServices()
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    await act(async () => root.render(createElement(HostContext.Provider, { value: host }, createElement(SpoolmanRows, { services }))))
    const input = el.querySelector<HTMLInputElement>('#spoolman-url')!
    await act(async () => type(input, '192.168.1.50'))
    await act(async () => button(el, 'Add Spoolman').click())
    await vi.waitFor(() => expect(el.textContent).toContain('1 spool in Spoolman.'))
    expect(saved.get('spoolman')).toBe('http://192.168.1.50:7912')
    expect(el.textContent).toContain('Connected')
    expect(get().spools?.length).toBe(1)
    await act(async () => button(el, 'Remove Spoolman').click())
    await vi.waitFor(() => expect(el.querySelector('#spoolman-url')).not.toBeNull())
    expect(saved.size).toBe(0)
    expect(get().spools).toEqual([])
    act(() => root.unmount())
    el.remove()
  })
})
