// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print watch runs on Windows, Linux and Apple silicon Macs. On an Intel Mac the desktop app never starts it
// (apps/desktop/src-tauri/src/watch.rs), so Settings shows no Print watch rows there.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalHost, Host, PrinterHost } from '@slicerx/contracts'
import { HostContext } from '../src/host'
import { registerCrashHost } from '../src/bugs/reports'
import { connectBridge, resetBridge, setBridgeConnector, type ConnectedBridge } from '../src/link/bridge'
import { BridgeSection } from '../src/link/section'
import { watchRunsOn } from '../src/link/watch-support'

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

/** The desktop shell as crash.rs reports itself: the OS with the CPU in brackets. */
function shell(os: string): void {
  registerCrashHost({ take: async () => ({ reports: [], pageLoads: 1, os }), ack: async () => undefined, testPanic: async () => undefined })
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
  registerCrashHost(null)
  await vi.dynamicImportSettled()
})

describe('Print watch rows by platform', () => {
  it('hides the rows on an Intel Mac', async () => {
    shell('macOS 15.1 (x86_64)')
    await settings()
    // Long enough for the rows to have come in, had they been going to.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText('Print watch')).toBeNull()
    expect(screen.queryByLabelText(/Let mimir confirm/)).toBeNull()
  })

  it.each(['macOS 15.1 (aarch64)', 'Windows 10.0.22631.4317 (x86_64)', 'Ubuntu 24.04.1 LTS (x86_64)', 'Ubuntu 24.04.1 LTS (aarch64)'])('shows the rows on %s', async (os) => {
    shell(os)
    await settings()
    await waitFor(() => expect(screen.getByText('Print watch')).toBeTruthy())
    expect(screen.getByLabelText(/Let mimir confirm/)).toBeTruthy()
  })

  it('shows the rows in the browser, which has no shell to ask', async () => {
    await settings()
    await waitFor(() => expect(screen.getByText('Print watch')).toBeTruthy())
  })

  it('reads only macOS on x86_64 as a computer without the watch', () => {
    expect(watchRunsOn('macOS 15.1 (x86_64)')).toBe(false)
    expect(watchRunsOn('macOS (x86_64)')).toBe(false)
    expect(watchRunsOn('macOS 15.1 (aarch64)')).toBe(true)
    expect(watchRunsOn('Windows 11 (x86_64)')).toBe(true)
    expect(watchRunsOn('Linux (x86_64)')).toBe(true)
    expect(watchRunsOn('')).toBe(true)
  })
})
