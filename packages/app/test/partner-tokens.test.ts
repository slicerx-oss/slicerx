// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiToken, AuthClient, StoreResult } from '@slicerx/contracts'
import { PartnerTokens } from '../src/features/store/partner-tokens'

// A made-up secret for a fake account; no service ever sees it.
const SECRET = `sxk_${'0'.repeat(64)}`

function fakeAccount() {
  const tokens: ApiToken[] = [{ id: 'cli', name: 'Laptop CLI', prefix: 'sxk_11111111', scopes: ['cli'], rateLimitPerMinute: 60, createdAt: '2026-11-01T00:00:00Z' }]
  const calls: string[] = []
  const store: Pick<AuthClient, 'createPartnerToken' | 'revokeApiToken'> = {
    async createPartnerToken(input): Promise<StoreResult<{ token: ApiToken; secret: string }>> {
      calls.push(`create ${input.partnerApp} ${input.expiresInDays}`)
      const token: ApiToken = { id: 'p1', name: input.partnerApp, partnerApp: input.partnerApp, prefix: SECRET.slice(0, 12), scopes: ['cloud_slice'], rateLimitPerMinute: 60, createdAt: '2026-11-05T00:00:00Z', expiresAt: '2027-11-05T00:00:00Z' }
      tokens.push(token)
      return { ok: true, value: { token, secret: SECRET } }
    },
    async revokeApiToken(id) {
      calls.push(`revoke ${id}`)
      const t = tokens.find((x) => x.id === id)
      if (t) t.revokedAt = '2026-11-05T01:00:00Z'
      return { ok: true, value: undefined }
    },
  }
  return { store, tokens, calls }
}

afterEach(() => cleanup())

function show(a: ReturnType<typeof fakeAccount>, qc = new QueryClient()) {
  return render(createElement(QueryClientProvider, { client: qc }, createElement(PartnerTokens, { store: a.store, tokens: a.tokens.slice(), pending: false })))
}

describe('Partner apps in account settings', () => {
  it('lists only partner app tokens and says when there are none', () => {
    show(fakeAccount())
    expect(screen.queryByText('Laptop CLI')).toBeNull()
    expect(screen.getByText('No partner app can slice on your account.')).toBeTruthy()
    expect((screen.getByTestId('partner-token-create') as HTMLButtonElement).disabled).toBe(true)
  })

  it('issues a token for a named app, shows the secret once, and hides it', async () => {
    const a = fakeAccount()
    show(a)
    fireEvent.change(screen.getByTestId('partner-token-name'), { target: { value: 'Example Phone' } })
    fireEvent.change(screen.getByTestId('partner-token-days'), { target: { value: '365' } })
    fireEvent.click(screen.getByTestId('partner-token-create'))
    await waitFor(() => expect(screen.getByTestId('partner-token-secret').textContent).toBe(SECRET))
    expect(a.calls).toEqual(['create Example Phone 365'])
    expect(screen.getByTestId('partner-token-made').textContent).toMatch(/shown only this once/)
    fireEvent.click(screen.getByTestId('partner-token-hide'))
    expect(screen.queryByTestId('partner-token-secret')).toBeNull()
  })

  it('shows an issued token by app with its expiry, and revokes it', async () => {
    const a = fakeAccount()
    await a.store.createPartnerToken({ partnerApp: 'Example Phone', expiresInDays: 365 })
    a.calls.length = 0
    show(a)
    const row = screen.getByTestId('partner-token-row')
    expect(row.textContent).toMatch(/Example Phone/)
    expect(row.textContent).toMatch(/Cloud slicing, expires Nov 5, 2027, never used/)
    expect(row.textContent).not.toContain(SECRET)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Example Phone' }))
    await waitFor(() => expect(a.calls).toEqual(['revoke p1']))
  })
})
