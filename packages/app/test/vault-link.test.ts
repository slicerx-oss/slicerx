// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Open in SlicerX on a design's page on the website: the app opens the Vault tab with that design's sheet, and says
// so when the design is not public.
import { afterEach, describe, expect, it } from 'vitest'
import { defineEditionConfig } from '@slicerx/edition-config'
import { createStore } from '@slicerx/store'
import { get } from '../src/state/store'
import { creatorUrl, listingUrl } from '../src/features/store/routes'
import { librarySheets, openVaultLink, resetSheets } from '../src/features/store/sheets'

afterEach(() => resetSheets())

describe('Vault links', () => {
  it('open the design by its slug in the Vault', async () => {
    const store = createStore({ offline: true })
    const { items } = await store.listListings({ limit: 1 })
    const listing = items[0]!.listing
    expect(await openVaultLink(store, listing.slug)).toBe(true)
    expect(get().workspace).toBe('feed')
    expect(librarySheets().listing).toBe(listing.id)
  })

  it('say so for a design that is not there, and open nothing', async () => {
    const store = createStore({ offline: true })
    expect(await openVaultLink(store, 'no-such-design')).toBe(false)
    expect(librarySheets().listing).toBeNull()
    expect(get().toast).toMatchObject({ tone: 'error', text: expect.stringContaining('isn\'t on the Vault') })
  })

  it("build the design's and the creator's page on the website", () => {
    const edition = defineEditionConfig({ apps: { web: { origin: 'https://slicerx.app' } } })
    expect(listingUrl(edition, 'x-mark')).toBe('https://slicerx.app/vault/x-mark')
    expect(creatorUrl(edition, 'slicerx-team')).toBe('https://slicerx.app/creators/slicerx-team')
  })
})
