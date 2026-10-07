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

function mount() {
  const signInWithEmail = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const store = { signInMethods: () => ['email'], signInWithEmail } as unknown as StoreClient
  const host = { kind: 'desktop', capabilities: {}, store } as unknown as Host
  const client = new QueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(HostContext.Provider, { value: host }, createElement(SignInForm))))
  return signInWithEmail
}

describe('a sign-in link that comes back and fails', () => {
  afterEach(() => cleanup())

  it('shows in the form after the link was sent, with a way to send a new one', async () => {
    const send = mount()
    fireEvent.change(await screen.findByPlaceholderText('you@example.com'), { target: { value: 'qa@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
    await screen.findByText(/We sent a sign-in link/)
    act(() => reportSignInResult({ ok: false, message: 'This link has expired or was already used. Send a new link.' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Sign-in did not finish. This link has expired or was already used.')
    fireEvent.click(screen.getByRole('button', { name: 'Send a new link' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
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
