// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { Host, StoreClient } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignInForm } from '../src/features/store/signin'
import { reportSignInResult } from '../src/lib/sign-in-result'
import { HostContext } from '../src/host'

type Who = { userId: string } | null
function mount(signInWithEmail = vi.fn(async (): Promise<{ ok: true; value: undefined } | { ok: false; code: string; message: string }> => ({ ok: true as const, value: undefined }))) {
  let push: ((s: Who) => void) | null = null
  const store = {
    signInMethods: () => ['email'],
    signInWithEmail,
    session: async () => null,
    onSessionChange: (cb: (s: Who) => void) => {
      push = cb
      return () => undefined
    },
  } as unknown as StoreClient
  const host = { kind: 'desktop', capabilities: {}, store } as unknown as Host
  const client = new QueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(HostContext.Provider, { value: host }, createElement(SignInForm))))
  return Object.assign(signInWithEmail, { session: (s: Who) => push?.(s) })
}

async function sendTo(address: string) {
  fireEvent.change(await screen.findByPlaceholderText('you@example.com'), { target: { value: address } })
  fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
  await screen.findByText(/We sent a sign-in link/)
}

describe('a sign-in link that comes back and fails', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows in the form after the link was sent, with a way to send a new one once the wait is over', async () => {
    // Only the clock and the countdown's interval are fake, so the seconds on the button are exact. Testing Library's
    // waits poll with setInterval too, so here they look again on each change to the page, not on a timer.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const send = mount()
    await sendTo('qa@example.com')
    act(() => reportSignInResult({ ok: false, message: 'This link has expired or was already used. Send a new link.' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Sign-in did not finish. This link has expired or was already used.')
    expect((screen.getByRole('button', { name: 'Send a new link in 60 s' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(61_000)
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Send a new link' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('counts Send again down from the wait the server names', async () => {
    // Only the clock and the countdown's interval are fake, so the seconds on the button are exact. Testing Library's
    // waits poll with setInterval too, so here they look again on each change to the page, not on a timer.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const send = vi.fn(async (): Promise<{ ok: true; value: undefined } | { ok: false; code: string; message: string }> => ({ ok: true as const, value: undefined }))
    mount(send)
    await sendTo('qa@example.com')
    await act(async () => {
      vi.advanceTimersByTime(61_000)
    })
    send.mockResolvedValueOnce({ ok: false, code: 'conflict', message: 'For security purposes, you can only request this after 32 seconds.' })
    fireEvent.click(await screen.findByRole('button', { name: 'Send again' }))
    expect((await screen.findByRole('alert')).textContent).toContain('after 32 seconds')
    expect(await screen.findByRole('button', { name: 'Send again in 32 s' })).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(await screen.findByRole('button', { name: 'Send again in 30 s' })).toBeTruthy()
  })

  it('offers Send again once the wait is over, even when the countdown starts late', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    mount()
    fireEvent.change(await screen.findByPlaceholderText('you@example.com'), { target: { value: 'qa@example.com' } })
    // Resolves as the sent view is committed, before React runs the effect that starts the countdown, so the clock
    // passes the whole wait first: what a stalled page or a busy test runner does.
    const committed = new Promise<void>((resolve) => {
      const o = new MutationObserver(() => {
        if (!document.body.textContent?.includes('We sent a sign-in link')) return
        o.disconnect()
        resolve()
      })
      o.observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
    await committed
    await act(async () => {
      vi.advanceTimersByTime(61_000)
    })
    expect(await screen.findByRole('button', { name: 'Send again' })).toBeTruthy()
  })

  it('starts over after signing in or out, never on an old sent link', async () => {
    // Each change waits for the form to come back: two changes inside one render would look like none.
    const m = mount()
    await sendTo('qa@example.com')
    act(() => m.session({ userId: 'u1' }))
    expect(await screen.findByPlaceholderText('you@example.com')).toBeTruthy()
    expect(screen.queryByText(/We sent a sign-in link/)).toBeNull()
    await sendTo('qa@example.com')
    act(() => m.session(null))
    expect(await screen.findByPlaceholderText('you@example.com')).toBeTruthy()
    expect(screen.queryByText(/We sent a sign-in link/)).toBeNull()
  })

  it('shows a failure that arrived before the form opened, once', async () => {
    reportSignInResult({ ok: false, message: 'This link answers an earlier request.' })
    mount()
    expect((await screen.findByRole('alert')).textContent).toContain('This link answers an earlier request.')
    cleanup()
    mount()
    await screen.findByPlaceholderText('you@example.com')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the account menu', () => {
  afterEach(() => cleanup())

  it('signs out from the Vault bar', async () => {
    const { VaultBar } = await import('../src/features/store/library')
    const signOut = vi.fn(async () => undefined)
    const store = {
      session: async () => ({ userId: 'u1', handle: 'qa2', displayName: 'qa2', role: 'member' }),
      onSessionChange: () => () => undefined,
      getMyCreator: async () => null,
      signInMethods: () => ['email'],
      signOut,
    } as unknown as StoreClient
    const host = { kind: 'desktop', capabilities: {}, store } as unknown as Host
    render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: host }, createElement(VaultBar))))
    fireEvent.click(await screen.findByRole('button', { name: 'qa2' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }))
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy()
  })
})
