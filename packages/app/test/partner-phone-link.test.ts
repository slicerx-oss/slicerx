// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Devices, Partner phones: linking a partner phone to a partner app key. A key with the phone's own name links at once;
// a key with another name links only after the person says yes to a warning, and then with mismatchOk.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalHost, Host, PrinterHost } from '@slicerx/contracts'
import { connectBridge, resetBridge, setBridgeConnector, type ConnectedBridge, type RememberedClient } from '../src/link/bridge'
import { DeviceRows } from '../src/link/devices'
import { setPhoneAccess, type PhoneAccess, type PhoneState } from '../src/lib/phone'
import type { BridgeRemote } from '../src/features/phone/remote'

const host = (): Host => ({ printers: { id: 'demo' }, approvals: { id: 'demo' }, secrets: { id: 'none' }, capabilities: { printers: 'sim', secureStorage: false } }) as unknown as Host

function fakeHub() {
  const made = new Date().toISOString()
  const rows: RememberedClient[] = [
    { id: 'key-lm', name: 'Example Phone', role: 'agent', partner: true, createdAt: made, lastSeenAt: null },
    { id: 'key-other', name: 'OtherApp', role: 'agent', partner: true, createdAt: made, lastSeenAt: null },
  ]
  const links: unknown[][] = []
  const remote = {
    status: async () => ({ enabled: true, relay: null, connected: true, sessions: 0, pairings: 1, lastError: null, quota: null }),
    configure: async () => ({ enabled: true, relay: null, connected: true, sessions: 0, pairings: 1, lastError: null, quota: null }),
    quota: async () => ({ enabled: true, relay: null, connected: true, sessions: 0, pairings: 1, lastError: null, quota: null }),
    pairings: {
      put: async () => undefined,
      remove: async () => undefined,
      list: async () => [{ pairingId: 'pp', kind: 'phone' as const, partner: 'Example Phone' }],
      link: async (...a: unknown[]) => void links.push(a),
    },
  } satisfies BridgeRemote
  const bridge: ConnectedBridge = {
    printers: { id: 'link' } as unknown as PrinterHost,
    approvals: { id: 'link-approvals' } as unknown as ApprovalHost,
    setup: { discover: async () => [], testConnection: async () => ({ ok: true, steps: [] }), addPrinter: async () => ({ printerId: 'p' }) },
    clients: { createPartner: async () => ({ clientId: 'x', clientKey: 'x' }), list: async () => rows.slice(), revoke: async () => undefined },
    remote,
    close: () => undefined,
  }
  return { bridge, links }
}

function fakePhone(): PhoneAccess {
  const state: PhoneState = { status: 'on', urls: [], devices: [{ id: 'pp', name: 'Pixel 8', platform: 'android', online: false, partner: 'Example Phone', approve: false, send: false }] }
  return { getState: () => state, subscribe: () => () => undefined, setEnabled: async () => undefined, revoke: async () => undefined, offer: async () => Promise.reject(new Error('no')), setPartnerRights: async () => undefined }
}

// jsdom has no modal dialogs.
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})
beforeEach(() => {
  resetBridge()
  setBridgeConnector(null)
})
afterEach(async () => {
  cleanup()
  setPhoneAccess(null)
  await vi.dynamicImportSettled()
})

describe('Partner phone key link', () => {
  it("links a key with the phone's name at once, and another only after the person says yes", async () => {
    const hub = fakeHub()
    setBridgeConnector({ automatic: true, connect: async () => hub.bridge })
    expect(await connectBridge(host())).toBe(true)
    setPhoneAccess(fakePhone())
    render(createElement(DeviceRows))
    const select = (await screen.findByTestId('partner-phone-key')) as HTMLSelectElement
    await waitFor(() => expect(select.disabled).toBe(false))

    await act(async () => void fireEvent.change(select, { target: { value: 'key-lm' } }))
    expect(hub.links).toEqual([['pp', 'key-lm', undefined]])

    await act(async () => void fireEvent.change(select, { target: { value: 'key-other' } }))
    expect(hub.links).toHaveLength(1)
    const dialog = await screen.findByRole('dialog', { name: 'Link to a key with another name?' })
    expect(dialog.textContent).toContain("This phone says it's Example Phone. Link it to the key OtherApp anyway?")
    await act(async () => void fireEvent.click(screen.getByTestId('partner-link-dont')))
    expect(hub.links).toHaveLength(1)

    await act(async () => void fireEvent.change(select, { target: { value: 'key-other' } }))
    await act(async () => void fireEvent.click(await screen.findByTestId('partner-link-anyway')))
    expect(hub.links.at(-1)).toEqual(['pp', 'key-other', { mismatchOk: true }])
  })
})
