// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalHost, Host, PrinterHost } from '@slicerx/contracts'
import { connectBridge, resetBridge, setBridgeConnector, type ConnectedBridge, type RememberedClient } from '../src/link/bridge'
import { DeviceRows } from '../src/link/devices'
import { AgentPanel } from '../src/pilot-connect/agent-panel'

// A made-up key for a fake hub; no real hub ever sees it.
const KEY = `sxp_${'0'.repeat(64)}`

function host(): Host {
  return { printers: { id: 'demo' }, approvals: { id: 'demo' }, secrets: { id: 'none' }, capabilities: { printers: 'sim', secureStorage: false } } as unknown as Host
}

function fakeHub() {
  const rows: RememberedClient[] = []
  const calls: string[] = []
  const bridge: ConnectedBridge = {
    printers: { id: 'link' } as unknown as PrinterHost,
    approvals: { id: 'link-approvals' } as unknown as ApprovalHost,
    setup: { discover: async () => [], testConnection: async () => ({ ok: true, steps: [] }), addPrinter: async () => ({ printerId: 'p' }) },
    clients: {
      async createPartner(name) {
        calls.push(`create ${name}`)
        rows.push({ id: 'client-1', name, role: 'agent', partner: true, createdAt: new Date().toISOString(), lastSeenAt: null })
        return { clientId: 'client-1', clientKey: KEY }
      },
      list: async () => rows.slice(),
      async revoke(id) {
        calls.push(`revoke ${id}`)
        rows.splice(rows.findIndex((r) => r.id === id), 1)
      },
    },
    close: () => undefined,
  }
  rows.push({ id: 'client-app', name: 'Studio', role: 'app', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
  return { bridge, rows, calls }
}

beforeEach(() => {
  resetBridge()
  setBridgeConnector(null)
})
afterEach(async () => {
  cleanup()
  await vi.dynamicImportSettled()
})

describe('Partner app key', () => {
  it('asks for the printer bridge first', () => {
    render(createElement(AgentPanel))
    fireEvent.click(screen.getByTestId('agent-partner'))
    expect(screen.getByRole('radio', { name: 'Partner app' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByTestId('partner-create') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Connect the printer bridge first/)).toBeTruthy()
  })

  it('makes a named key, shows it once, and lists it in Devices, where it is revoked', async () => {
    const hub = fakeHub()
    setBridgeConnector({ automatic: true, connect: async () => hub.bridge })
    expect(await connectBridge(host())).toBe(true)
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })

    render(createElement(AgentPanel))
    fireEvent.click(screen.getByTestId('agent-partner'))
    fireEvent.change(screen.getByTestId('partner-name'), { target: { value: '  LayerMate ' } })
    await act(async () => void fireEvent.click(screen.getByTestId('partner-create')))
    expect(hub.calls).toEqual(['create LayerMate'])
    expect(screen.getByTestId('partner-key').textContent).toBe(KEY)
    await act(async () => void fireEvent.click(screen.getByTestId('partner-copy')))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(KEY)
    fireEvent.click(screen.getByTestId('partner-hide'))
    expect(screen.queryByTestId('partner-key')).toBeNull()
    expect(document.body.textContent).not.toContain(KEY)
    cleanup()

    render(createElement(DeviceRows))
    const row = await screen.findByTestId('device-client-1')
    expect(row.textContent).toContain('LayerMate')
    expect(row.textContent).toMatch(/Partner app, made .+, not used yet/)
    // The app's own key is not a device to revoke here.
    expect(screen.queryByTestId('device-client-app')).toBeNull()
    await act(async () => void fireEvent.click(screen.getByTestId('device-revoke-client-1')))
    expect(hub.calls).toContain('revoke client-1')
    await waitFor(() => expect(screen.getByTestId('devices-empty')).toBeTruthy())
  })
})
