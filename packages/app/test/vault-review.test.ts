// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { createStore } from '@slicerx/store'
import { HostContext } from '../src/host'
import { canReview, ReviewHost } from '../src/features/store/review'
import { openReview, resetSheets } from '../src/features/store/sheets'

afterEach(() => {
  cleanup()
  resetSheets()
})

function mount(as: string) {
  const store = createStore({ offline: true, signedInAs: as, now: () => new Date('2026-09-30T20:00:00Z') })
  const host = { kind: 'web', capabilities: { secureStorage: false }, store } as unknown as Host
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(HostContext.Provider, { value: host }, createElement(ReviewHost))))
  act(() => openReview())
  return store
}

describe('review queue', () => {
  it('is for the owner and moderators', () => {
    expect(['owner', 'moderator', 'creator', 'member', 'banned', null].map(canReview)).toEqual([true, true, false, false, false, false])
  })

  it('approves an upload that passed the scan, and it goes live', async () => {
    const store = mount('owner')
    const list = await screen.findByRole('list', { name: 'Waiting for review' })
    const row = within(list).getAllByRole('listitem').find((li) => within(li).queryByText('Scan passed')) as HTMLElement
    const title = row.querySelector('.up-title')?.textContent ?? ''
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Waiting for review' })).queryByText(title)).toBeNull())
    expect((await store.listListings({ limit: 100 })).items.some((c) => c.listing.title === title)).toBe(true)
  })

  it('sends one back with a note only when the note is long enough', async () => {
    const store = mount('owner')
    const list = await screen.findByRole('list', { name: 'Waiting for review' })
    const row = within(list).getAllByRole('listitem')[0] as HTMLElement
    const title = row.querySelector('.up-title')?.textContent ?? ''
    fireEvent.click(within(row).getByRole('button', { name: 'Send back' }))
    const send = within(row).getAllByRole('button', { name: 'Send back' }).find((b) => b.getAttribute('type') === 'submit') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(within(row).getByLabelText('Why it goes back'), { target: { value: 'Add a photo of the print' } })
    fireEvent.click(send)
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Waiting for review' })).queryByText(title)).toBeNull())
    const queue = await store.moderationQueue()
    expect(queue.ok && queue.value.some((i) => i.title === title)).toBe(false)
  })
})
