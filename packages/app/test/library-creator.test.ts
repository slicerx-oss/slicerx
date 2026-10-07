// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Creator, CreatorPage, Host, Listing, ListingCard, StoreClient } from '@slicerx/contracts'
import { createStore } from '@slicerx/store'
import { HostContext } from '../src/host'
import { CreatorEditorHost, draftErrors, initialDraft, previewPage, saveDraft, suggestHandle, type EditorDraft } from '../src/features/store/creator-editor'
import { count, CreatorSheetView } from '../src/features/store/creator-sheet'
import { ago } from '../src/features/store/library'
import { linkText } from '../src/features/store/links'
import { pickFeatured, ROWS, withoutFeatured } from '../src/features/store/rows'
import { openEditor, resetSheets } from '../src/features/store/sheets'

beforeAll(() => {
  // jsdom has no modal dialogs.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

afterEach(() => {
  cleanup()
  resetSheets()
})

const creator: Creator = { id: 'c1', handle: 'marrow-works', displayName: 'Marrow Works', tagline: 'Fossils', bio: 'Print-in-place fossils.\nTuned for 0.4 mm.', followers: 1234, ownerId: 'u1', status: 'active', trusted: false, createdAt: '2026-06-01T00:00:00Z', listingCount: 2 }
const listing = (id: string, title: string, downloads = 10): Listing => ({ id, creatorId: 'c1', slug: id, title, license: 'cc-by', status: 'approved', tags: [], createdAt: '2026-06-01T00:00:00Z', stats: { likes: 1, makes: 0, comments: 0, downloads } })
const page: CreatorPage = {
  creator,
  links: [
    { id: 'k1', kind: 'patreon', url: 'https://www.patreon.com/marrow', position: 0 },
    { id: 'k2', kind: 'makerworld', label: 'My MakerWorld', url: 'https://makerworld.com/en/@marrow', position: 1 },
    { id: 'k3', kind: 'website', url: 'https://www.marrow.example.org/shop', position: 2 },
  ],
  featured: [listing('l2', 'Fossil fish', 400)],
  listings: [listing('l1', 'Skull planter', 100), listing('l2', 'Fossil fish', 400)],
}

describe('creator sheet', () => {
  it('shows the page: name, handle, stats, bio, pinned design and readable links', () => {
    render(createElement(CreatorSheetView, { page }))
    expect(screen.getByRole('heading', { name: 'Marrow Works' })).toBeTruthy()
    expect(screen.getByText('@marrow-works')).toBeTruthy()
    expect(screen.getByText('500 downloads')).toBeTruthy()
    expect(screen.getByText('1,234 followers')).toBeTruthy()
    expect(screen.getByText('Creator')).toBeTruthy()
    expect(screen.getByText(/Print-in-place fossils/)).toBeTruthy()
    const pinned = screen.getByRole('region', { name: 'Pinned design' })
    expect(within(pinned).getByText('Fossil fish')).toBeTruthy()
    const links = screen.getByRole('region', { name: 'Creator links' })
    expect(within(links).getByText('Patreon')).toBeTruthy()
    expect(within(links).getByText('Marrow Works on Patreon')).toBeTruthy()
    expect(within(links).getByText('My MakerWorld')).toBeTruthy()
    expect(within(links).getByText('marrow.example.org')).toBeTruthy()
    // The first link is the highlighted one.
    expect(within(links).getAllByRole('link')[0]?.hasAttribute('data-feature')).toBe(true)
    // Never the raw URL as text.
    expect(links.textContent).not.toMatch(/https?:/)
    expect(screen.getByRole('button', { name: 'Follow' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit page' })).toBeNull()
  })

  it('switches to Uploads and back with the tabs', () => {
    render(createElement(CreatorSheetView, { page }))
    fireEvent.click(screen.getByRole('tab', { name: /Uploads/ }))
    expect(screen.getByRole('tab', { name: /Uploads/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Skull planter')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Creator links' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('tab', { name: /Uploads/ }), { key: 'ArrowLeft' })
    expect(screen.getByRole('region', { name: 'Creator links' })).toBeTruthy()
  })

  it('offers Edit page instead of Follow on your own page, and opens what you click', () => {
    const opened: string[] = []
    let edited = 0
    render(createElement(CreatorSheetView, { page, own: true, onEdit: () => edited++, onOpenListing: (l: Listing) => opened.push(l.id) }))
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit page' }))
    expect(edited).toBe(1)
    fireEvent.click(within(screen.getByRole('region', { name: 'Pinned design' })).getByRole('button'))
    expect(opened).toEqual(['l2'])
  })

  it('shows the location and the tags staff set, in their own color', () => {
    render(createElement(CreatorSheetView, { page: { ...page, creator: { ...creator, location: 'Melbourne', badges: ['N3D team'] } } }))
    expect(screen.getByText('@marrow-works · Melbourne')).toBeTruthy()
    expect(screen.getByText('N3D team').hasAttribute('data-staff')).toBe(true)
    expect(screen.getByText('Creator').hasAttribute('data-staff')).toBe(false)
  })

  it('shows Following when you already follow', () => {
    render(createElement(CreatorSheetView, { page: { ...page, creator: { ...creator, followedByMe: true } } }))
    expect(screen.getByRole('button', { name: 'Following' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('creator links', () => {
  it('reads as the label, the service name, or the bare host', () => {
    expect(linkText({ kind: 'kofi', url: 'https://ko-fi.com/x' })).toBe('Ko-fi')
    expect(linkText({ kind: 'kofi', label: '  Tip jar ', url: 'https://ko-fi.com/x' })).toBe('Tip jar')
    expect(linkText({ kind: 'other', url: 'https://www.shop.example.com/a?b=1' })).toBe('shop.example.com')
    expect(linkText({ kind: 'x', url: 'https://x.com/me' })).toBe('X')
  })
})

describe('library rows', () => {
  const card = (id: string): ListingCard => ({ listing: listing(id, id), creator })
  it('keeps the owner order', () => {
    expect(ROWS.map((r) => r.id)).toEqual(['popular', 'recent', 'trending', 'new-creators', 'liked'])
    expect(ROWS.find((r) => r.id === 'liked')?.signedIn).toBe(true)
  })
  it('features the top trending design, else the most popular one', () => {
    expect(pickFeatured([card('t')], [card('p')])?.listing.id).toBe('t')
    expect(pickFeatured([], [card('p')])?.listing.id).toBe('p')
    expect(pickFeatured(undefined, undefined)).toBeNull()
  })
  it('does not repeat the featured design in a row', () => {
    expect(withoutFeatured([card('a'), card('b')], card('a')).map((c) => c.listing.id)).toEqual(['b'])
    expect(withoutFeatured([card('a')], null)).toHaveLength(1)
  })
})

describe('creator page editor logic', () => {
  const session = { userId: 'u1', handle: 'Ana Silva', displayName: 'Ana Silva' }
  const draft = (over: Partial<EditorDraft> = {}): EditorDraft => ({ ...initialDraft(null, session), displayName: 'Ana', handle: 'ana-prints', ...over })

  it('suggests a handle from the account', () => {
    expect(suggestHandle({ handle: 'Ana Silva', displayName: 'x' })).toBe('ana-silva')
    expect(suggestHandle({ displayName: 'Zoë' })).toBe('zoe')
    expect(suggestHandle({ handle: 'rv' })).toBe('')
  })

  it('starts from the page, with the pinned design first and the links in order', () => {
    const d = initialDraft(page, session)
    expect(d).toMatchObject({ handle: 'marrow-works', displayName: 'Marrow Works', pinnedId: 'l2' })
    expect(d.links.map((l) => l.kind)).toEqual(['patreon', 'makerworld', 'website'])
  })

  it('checks the handle, name, bio and links like the database', () => {
    expect(draftErrors(draft(), false)).toEqual({})
    expect(draftErrors(draft({ handle: 'admin' }), false).handle).toBe('That handle is reserved')
    expect(draftErrors(draft({ handle: 'Bad Handle' }), true).handle).toBeUndefined()
    expect(draftErrors(draft({ displayName: '  ' }), false).displayName).toBeTruthy()
    expect(draftErrors(draft({ bio: 'x'.repeat(1001) }), false).bio).toBeTruthy()
    const e = draftErrors(draft({ links: [{ key: 'a', kind: 'makerworld', url: 'https://example.com/me' }, { key: 'b', kind: 'website', url: 'http://plain.example.com' }] }), false)
    expect(e['link:a']).toBe('A MakerWorld link must point to makerworld.com')
    expect(e['link:b']).toBe('Links must start with https://')
    const dup = draftErrors(draft({ links: [{ key: 'a', kind: 'website', url: 'https://a.example.com' }, { key: 'b', kind: 'other', url: 'https://a.example.com' }] }), false)
    expect(dup['link:b']).toBe('This address is already on the page')
  })

  it('previews the draft as the sheet will show it', () => {
    const d = { ...initialDraft(page, session), displayName: 'Marrow', bio: '', pinnedId: 'l1', banner: { kind: 'remove' as const }, links: [{ key: 'z', kind: 'patreon' as const, url: 'https://patreon.com/m' }, { key: 'y', kind: 'patreon' as const, url: 'nope' }] }
    const p = previewPage(d, { ...page, creator: { ...creator, bannerUrl: 'https://cdn.example.com/b.webp' } }, [], null)
    expect(p.creator.displayName).toBe('Marrow')
    expect(p.creator.bio).toBeUndefined()
    expect(p.creator.bannerUrl).toBeUndefined()
    expect(p.featured.map((l) => l.id)).toEqual(['l1'])
    expect(p.links.map((l) => l.url)).toEqual(['https://patreon.com/m'])
  })

  it('saves the page, then images, links and the pinned design, keeping the other featured ones', async () => {
    const calls: string[] = []
    const ok = <T>(value: T) => ({ ok: true as const, value })
    const store = {
      saveCreator: async (i: { bannerUrl?: string | null }) => {
        calls.push(i.bannerUrl === undefined ? 'save' : `save banner=${i.bannerUrl}`)
        return ok(creator)
      },
      uploadCreatorImage: async (i: { kind: string }) => {
        calls.push(`upload ${i.kind}`)
        return ok('https://cdn.example.com/new.webp')
      },
      setCreatorLinks: async (l: unknown[]) => {
        calls.push(`links ${l.length}`)
        return ok([])
      },
      setFeatured: async (ids: string[]) => {
        calls.push(`featured ${ids.join(',')}`)
        return ok(undefined)
      },
    } as unknown as StoreClient
    const withThree = { ...page, featured: [listing('l2', 'a'), listing('l3', 'b'), listing('l4', 'c')] }
    const d: EditorDraft = { ...initialDraft(withThree, session), pinnedId: 'l4', banner: { kind: 'new', image: { bytes: new Uint8Array([1]), contentType: 'image/png', preview: 'blob:x' } } }
    const r = await saveDraft(store, d, withThree)
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['save', 'upload banner', 'save banner=https://cdn.example.com/new.webp', 'links 3', 'featured l4,l3'])
  })

  it('stops at the first failure and says which part failed', async () => {
    const store = {
      saveCreator: async () => ({ ok: true, value: creator }),
      uploadCreatorImage: async () => ({ ok: false, code: 'invalid', message: 'too big' }),
    } as unknown as StoreClient
    const d: EditorDraft = { ...initialDraft(page, session), logo: { kind: 'new', image: { bytes: new Uint8Array([1]), contentType: 'image/png', preview: 'blob:x' } } }
    expect(await saveDraft(store, d, page)).toEqual({ ok: false, message: 'The logo did not upload: too big' })
  })

  const img = { bytes: new Uint8Array([1]), contentType: 'image/png', preview: 'blob:x' }
  it('removes the images it uploaded when a later step fails, and keeps them once the page shows them', async () => {
    const removed: string[] = []
    let saves = 0
    const base = {
      uploadCreatorImage: async (i: { kind: string }) => (i.kind === 'logo' ? { ok: false, code: 'invalid', message: 'too big' } : { ok: true, value: `https://cdn.example.com/${i.kind}.webp` }),
      removeCreatorImage: async (url: string) => (removed.push(url), { ok: true, value: undefined }),
      saveCreator: async () => (saves++, { ok: true, value: creator }),
      setCreatorLinks: async () => ({ ok: false, code: 'invalid', message: 'bad link' }),
    }
    // The banner uploads, then the logo fails: the banner goes.
    const both: EditorDraft = { ...initialDraft(page, session), banner: { kind: 'new', image: img }, logo: { kind: 'new', image: img } }
    expect(await saveDraft(base as unknown as StoreClient, both, page)).toEqual({ ok: false, message: 'The logo did not upload: too big' })
    expect(removed).toEqual(['https://cdn.example.com/banner.webp'])
    // The second save (with the image) fails: the image goes.
    removed.length = 0
    saves = 0
    const failSecond = { ...base, saveCreator: async () => (++saves === 2 ? { ok: false, code: 'invalid', message: 'The banner must come from your creator page' } : { ok: true, value: creator }) }
    const banner: EditorDraft = { ...initialDraft(page, session), banner: { kind: 'new', image: img } }
    expect(await saveDraft(failSecond as unknown as StoreClient, banner, page)).toEqual({ ok: false, message: 'The banner must come from your creator page' })
    expect(removed).toEqual(['https://cdn.example.com/banner.webp'])
    // The page took the image; a link failure after that keeps it.
    removed.length = 0
    expect(await saveDraft(base as unknown as StoreClient, banner, page)).toEqual({ ok: false, message: 'bad link' })
    expect(removed).toEqual([])
    // A store that throws comes back as a message, and still cleans up.
    const throwing = { ...base, saveCreator: async () => (++saves > 4 ? Promise.reject(new Error('offline')) : { ok: true, value: creator }) }
    saves = 4
    expect(await saveDraft(throwing as unknown as StoreClient, { ...initialDraft(page, session) }, page)).toEqual({ ok: false, message: 'The page did not save: offline' })
  })
})

describe('creator page editor', () => {
  function mount(as: string) {
    const store = createStore({ offline: true, signedInAs: as, now: () => new Date('2026-09-30T20:00:00Z') })
    const host = { kind: 'web', capabilities: { secureStorage: false }, store } as unknown as Host
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(HostContext.Provider, { value: host }, createElement(CreatorEditorHost))))
    return store
  }

  it('edits an existing page with a live preview and saves it', async () => {
    const store = mount('marrow')
    act(() => openEditor('edit'))
    const name = await screen.findByLabelText(/Display name/)
    const dialog = screen.getByRole('dialog', { name: 'Creator page' })
    expect((name as HTMLInputElement).value).toBe('Marrow Works')
    const handle = within(dialog).getByLabelText(/Handle/) as HTMLInputElement
    expect(handle.readOnly).toBe(true)
    const preview = within(dialog).getByRole('region', { name: 'Preview' })
    fireEvent.change(name, { target: { value: 'Marrow Works Studio' } })
    expect(within(preview).getByRole('heading', { name: 'Marrow Works Studio' })).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText(/^Bio/), { target: { value: 'New bio.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect((await store.getMyCreator())?.displayName).toBe('Marrow Works Studio'))
    expect((await store.getMyCreator())?.bio).toBe('New bio.')
  })

  it('blocks Save on a bad link and shows why next to it', async () => {
    const store = mount('marrow')
    act(() => openEditor('edit'))
    await screen.findByLabelText(/Display name/)
    const dialog = screen.getByRole('dialog', { name: 'Creator page' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add link' }))
    const n = within(dialog).getAllByLabelText(/address$/).length
    fireEvent.change(within(dialog).getByLabelText(`Link ${n} address`), { target: { value: 'https://evil.example.com' } })
    fireEvent.change(within(dialog).getByLabelText(`Link ${n} site`), { target: { value: 'patreon' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('A Patreon link must point to patreon.com')).toBeTruthy()
    const page = await store.getCreatorByHandle('marrow-works')
    expect(page?.links.some((l) => l.url.includes('evil'))).toBe(false)
  })

  it('shows why a save failed instead of sitting at Unsaved changes', async () => {
    const store = mount('marrow')
    store.saveCreator = async () => ({ ok: false, code: 'invalid', message: 'Bios can be at most 500 characters' })
    act(() => openEditor('edit'))
    await screen.findByLabelText(/Display name/)
    const dialog = screen.getByRole('dialog', { name: 'Creator page' })
    fireEvent.change(within(dialog).getByLabelText(/^Bio/), { target: { value: 'Changed.' } })
    expect(within(dialog).getByRole('status').textContent).toBe('Unsaved changes')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toBe('Not saved: Bios can be at most 500 characters'))
    fireEvent.change(within(dialog).getByLabelText(/^Bio/), { target: { value: 'Changed again.' } })
    expect(within(dialog).getByRole('status').textContent).toBe('Unsaved changes')
  })

  it('sets up a page from Upload for a member without one', async () => {
    const store = mount('rv')
    act(() => openEditor('upload'))
    await screen.findByLabelText(/Display name/)
    const dialog = screen.getByRole('dialog', { name: 'Set up your creator page' })
    expect(within(dialog).getByRole('button', { name: 'Skip for now' })).toBeTruthy()
    const handle = within(dialog).getByLabelText(/Handle/) as HTMLInputElement
    expect(handle.readOnly).toBe(false)
    fireEvent.change(handle, { target: { value: 'rv-prints' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and upload' }))
    await waitFor(async () => expect((await store.getMyCreator())?.handle).toBe('rv-prints'))
  })

  it('caps links at 8, counts the bio to 500, and Discard puts the page back', async () => {
    mount('marrow')
    act(() => openEditor('edit'))
    await screen.findByLabelText(/Display name/)
    const dialog = screen.getByRole('dialog', { name: 'Creator page' })
    expect(within(dialog).getByText(/of 500$/)).toBeTruthy()
    const add = within(dialog).getByRole('button', { name: 'Add link' })
    while (!(add as HTMLButtonElement).disabled) fireEvent.click(add)
    expect(within(dialog).getAllByLabelText(/address$/)).toHaveLength(8)
    expect(within(dialog).getByText('Unsaved changes')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    expect(within(dialog).queryByText('Unsaved changes')).toBeNull()
    expect(within(dialog).getAllByLabelText(/address$/).length).toBeLessThan(8)
    fireEvent.change(within(dialog).getByLabelText(/Location/), { target: { value: 'Hobart' } })
    expect(within(within(dialog).getByRole('region', { name: 'Preview' })).getByText(/· Hobart$/)).toBeTruthy()
  })
})

describe('Vault numbers', () => {
  it('counts like the mockup and says how long ago', () => {
    expect([0, 4812, 9999, 21_600, 1_204_000].map(count)).toEqual(['0', '4,812', '9,999', '21.6k', '1.2m'])
    const now = Date.parse('2026-10-07T12:00:00Z')
    expect(ago('2026-10-07T10:00:00Z', now)).toBe('2 h ago')
    expect(ago('2026-10-04T12:00:00Z', now)).toBe('3 d ago')
    expect(ago('2026-09-23T12:00:00Z', now)).toBe('2 w ago')
  })
})
