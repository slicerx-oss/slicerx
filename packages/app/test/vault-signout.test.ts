// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Signing out while a session read is still on its way: the read started signed in, so it must not bring the
// account back once it lands.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Host, StoreClient } from '@slicerx/contracts'
import { createStore } from '@slicerx/store'
import { HostContext } from '../src/host'
import { VaultBar } from '../src/features/store/library'
import { resetSheets } from '../src/features/store/sheets'

afterEach(() => {
  cleanup()
  resetSheets()
})

/**
 * The offline store, with a gate that holds session reads after they have read the account, like a slow profile
 * fetch. Without events, the sign-out is not reported through onSessionChange either, so only the sign-out path clears it.
 */
function slowStore(events: boolean) {
  const base = createStore({ offline: true, signedInAs: 'marrow', now: () => new Date('2026-09-30T20:00:00Z') })
  let gate: Promise<void> | null = null
  let open = () => {}
  const store: StoreClient = {
    ...base,
    async session() {
      const s = await base.session()
      if (gate) await gate
      return s
    },
    ...(events ? {} : { onSessionChange: () => () => {} }),
  }
  const hold = () => {
    gate = new Promise((r) => (open = r))
  }
  const release = () => {
    gate = null
    open()
  }
  return { store, hold, release }
}

function mount(store: StoreClient) {
  const host = { kind: 'desktop', capabilities: { secureStorage: false }, store } as unknown as Host
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(HostContext.Provider, { value: host }, createElement(VaultBar))))
  return client
}

describe('signing out of the Vault', () => {
  it.each([
    ['with session events', true],
    ['without session events', false],
  ])('stays signed out when a session read that started signed in finishes afterwards (%s)', async (_name, events) => {
    const { store, hold, release } = slowStore(events)
    const client = mount(store)
    fireEvent.click(await screen.findByTestId('account-menu'))
    // A refetch while still signed in (the window regaining focus, a saved creator page, a remount once stale) that is
    // slow to come back.
    hold()
    const refetch = client.invalidateQueries({ queryKey: ['session'] })
    fireEvent.click(screen.getByTestId('account-sign-out'))
    await screen.findByTestId('vault-sign-in')
    // The read lands after the sign-out.
    await act(async () => {
      release()
      await refetch
      // The query cache tells components on a timer.
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(client.getQueryData(['session'])).toBeNull()
    expect(screen.queryByTestId('account-menu')).toBeNull()
    expect(screen.getByTestId('vault-sign-in')).toBeTruthy()
    expect(await store.session()).toBeNull()
  })
})
