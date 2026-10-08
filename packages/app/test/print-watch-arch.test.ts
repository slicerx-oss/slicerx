// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print watch runs on Windows, Linux and Apple silicon Macs. On an Intel Mac the desktop app never starts it
// (apps/desktop/src-tauri/src/watch.rs), so Settings shows no Print watch rows there. The shell names its CPU (shell_arch).
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalHost, Host, PrinterHost } from '@slicerx/contracts'
import { HostContext } from '../src/host'
import { connectBridge, resetBridge, setBridgeConnector, type ConnectedBridge } from '../src/link/bridge'
import { BridgeSection } from '../src/link/section'
import { registerShellArch } from '../src/link/watch-support'

function host(): Host {
  return { kind: 'desktop', printers: { id: 'demo' } as unknown as PrinterHost, approvals: { id: 'demo' } as unknown as ApprovalHost, secrets: { id: 'none' }, capabilities: { printers: 'sim', secureStorage: false } } as unknown as Host
}

function bridge(): ConnectedBridge {
  return {
    printers: { list: async () => [{ id: 'p1', name: 'Bay 1', family: 'bambu-lan' }] } as unknown as PrinterHost,
    approvals: { id: 'link-approvals' } as unknown as ApprovalHost,
    streams: { open: async () => { throw new Error('none') } },
    setup: {} as ConnectedBridge['setup'],
    secrets: { id: 'link-secrets' } as never,
    watch: { huginnPrinters: async () => [], setHuginn: async () => undefined },
    close: () => undefined,
  }
}

/** The desktop shell on `platform` (navigator.platform, as the web view reports it) answering shell_arch with `arch`. */
function shell(platform: string, arch: string | Error): void {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
  registerShellArch(async () => {
    if (arch instanceof Error) throw arch
    return arch
  })
}

async function settings(): Promise<void> {
  setBridgeConnector({ automatic: true, connect: async () => bridge() })
  const h = host()
  expect(await connectBridge(h)).toBe(true)
  render(createElement(HostContext.Provider, { value: h }, createElement(BridgeSection)))
  await screen.findByText('Connected')
}

beforeEach(() => {
  resetBridge()
  setBridgeConnector(null)
})

afterEach(async () => {
  cleanup()
  registerShellArch(null)
  vi.restoreAllMocks()
  await vi.dynamicImportSettled()
})

describe('Print watch rows by platform', () => {
  it('hides the rows on an Intel Mac', async () => {
    shell('MacIntel', 'x86_64')
    await settings()
    // Long enough for the rows to have come in, had they been going to.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText('Print watch')).toBeNull()
    expect(screen.queryByLabelText(/Let mimir confirm/)).toBeNull()
  })

  it.each([
    ['an Apple silicon Mac', 'MacIntel', 'aarch64'],
    ['Windows', 'Win32', 'x86_64'],
    ['Linux on x86_64', 'Linux x86_64', 'x86_64'],
    ['Linux on arm64', 'Linux aarch64', 'aarch64'],
  ])('shows the rows on %s', async (_name, platform, arch) => {
    shell(platform, arch)
    await settings()
    await waitFor(() => expect(screen.getByText('Print watch')).toBeTruthy())
    expect(screen.getByLabelText(/Let mimir confirm/)).toBeTruthy()
  })

  it('shows the rows on a Mac whose shell does not answer', async () => {
    shell('MacIntel', new Error('shell_arch not allowed'))
    await settings()
    await waitFor(() => expect(screen.getByText('Print watch')).toBeTruthy())
  })

  it('shows the rows in the browser, which has no shell to ask', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    await settings()
    await waitFor(() => expect(screen.getByText('Print watch')).toBeTruthy())
  })
})
