// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When a scan finds nothing on Windows, a firewall prompt that was dismissed is a likely cause: the listener for
// printer announcements is blocked, while entering the IP address still works. The desktop app reads the firewall's
// rules for itself and says which it is, offering Windows' own page to allow it.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoAnswerHint, noAnswerHint } from '../src/first-run/printer-step'
import { HostContext } from '../src/host'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('the hint when no printer answered', () => {
  it('names the Windows firewall prompt on Windows', () => {
    const w = noAnswerHint(true)
    expect(w).toMatch(/firewall/i)
    expect(w).toMatch(/IP address/)
  })
  it('stays as it was elsewhere', () => {
    expect(noAnswerHint(false)).not.toMatch(/firewall/i)
    expect(noAnswerHint(false)).toMatch(/same network/)
  })
  it('says the firewall blocks the app when its rules do', () => {
    expect(noAnswerHint(true, 'blocked')).toMatch(/Windows Firewall blocks/)
    expect(noAnswerHint(true, 'none')).toMatch(/Windows Firewall does not let/)
    for (const v of ['blocked', 'none'] as const) expect(noAnswerHint(true, v)).toMatch(/IP address/)
  })
  it('leaves the firewall out when its rules allow the app', () => {
    expect(noAnswerHint(true, 'allowed')).not.toMatch(/firewall/i)
    expect(noAnswerHint(true, 'unsupported')).toBe(noAnswerHint(true))
  })
})

describe('the firewall check after an empty scan', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  async function render(windows: boolean, firewall?: { inbound: () => Promise<string>; openSettings: () => Promise<void> }) {
    const host = { kind: 'desktop', capabilities: {}, ...(firewall ? { firewall } : {}) }
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    await act(async () => root.render(createElement(HostContext.Provider, { value: host as never }, createElement(NoAnswerHint, { windows }))))
    return el
  }

  it('offers Windows Firewall settings when the app is blocked, and opens them only on a click', async () => {
    const openSettings = vi.fn(async () => undefined)
    const el = await render(true, { inbound: async () => 'blocked', openSettings })
    expect(el.textContent).toMatch(/Windows Firewall blocks/)
    const button = [...el.querySelectorAll('button')].find((b) => /Allow in Windows Firewall/.test(b.textContent ?? ''))
    expect(button).toBeDefined()
    expect(openSettings).not.toHaveBeenCalled()
    await act(async () => button!.click())
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('offers nothing when the app is allowed', async () => {
    const el = await render(true, { inbound: async () => 'allowed', openSettings: async () => undefined })
    expect(el.textContent).not.toMatch(/firewall/i)
    expect(el.querySelector('button')).toBeNull()
  })

  it('does not ask outside Windows, or without the check', async () => {
    const inbound = vi.fn(async () => 'blocked')
    const el = await render(false, { inbound, openSettings: async () => undefined })
    expect(inbound).not.toHaveBeenCalled()
    expect(el.querySelector('button')).toBeNull()
    const web = await render(true)
    expect(web.textContent).toMatch(/firewall prompt/)
    expect(web.querySelector('button')).toBeNull()
  })
})
