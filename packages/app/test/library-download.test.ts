// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { Creator, DownloadLink, Host, Listing, ListingVersion, StoreClient, StoreResult } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchModel, isLibraryFormat } from '../src/features/store/download'
import { Detail } from '../src/features/store/library'
import { get, set } from '../src/state/store'
import { creatorUrl, dashboardUrl, privacyUrl, signInUrl } from '../src/features/store/routes'
import { NEUTRAL } from '../src/edition'
import { HostContext } from '../src/host'

const HostContextProvider = HostContext.Provider

const listing = { id: 'l1', title: 'Clip' } as Listing
const store = (r: StoreResult<DownloadLink>) => ({ download: async () => r }) as unknown as StoreClient
const link = (url: string, fileName = 'clip.sx3mf'): StoreResult<DownloadLink> => ({ ok: true, value: { url, versionId: 'v', version: '1.0.0', fileName } })
const respond = (status: number, body = new Uint8Array([1, 2, 3])) => (async () => new Response(body, { status })) as unknown as typeof fetch

describe('fetching a library model', () => {
  it('asks for sign-in when the store needs a session', async () => {
    const r = await fetchModel(store({ ok: false, code: 'not_signed_in', message: 'x' }), listing, respond(200))
    expect(r).toMatchObject({ ok: false, reason: 'sign-in' })
  })
  it('returns the bytes and the file name', async () => {
    const r = await fetchModel(store(link('https://cdn.example/clip.sx3mf')), listing, respond(200))
    expect(r.ok && r.name).toBe('clip.sx3mf')
    expect(r.ok && new Uint8Array(r.bytes).length).toBe(3)
  })
  it('reports a catalog entry with no file', async () => {
    const r = await fetchModel(store(link('seed://x')), listing, respond(200))
    expect(r).toMatchObject({ ok: false, reason: 'error' })
  })
  it('reports http failures and wrong formats', async () => {
    expect(await fetchModel(store(link('https://a/b')), listing, respond(403))).toMatchObject({ ok: false, message: 'The download failed (403).' })
    expect(await fetchModel(store(link('https://a/b', 'run.exe')), listing, respond(200))).toMatchObject({ ok: false })
  })
  it('takes a Vault file only as .sx3mf, unless it is the creator downloading their own', async () => {
    for (const name of ['clip.stl', 'clip.3mf', 'clip.obj']) {
      expect(await fetchModel(store(link('https://cdn.example/x', name)), listing, respond(200))).toMatchObject({ ok: false, message: 'Clip is not available as an .sx3mf yet.' })
    }
    const own = await fetchModel(store(link('https://cdn.example/x', 'clip.stl')), listing, respond(200), true)
    expect(own.ok && own.name).toBe('clip.stl')
  })
  it('sends the grant headers of a signed-out download', async () => {
    let sent: RequestInit | undefined
    const grab = (async (_url: string, init?: RequestInit) => ((sent = init), new Response(new Uint8Array([1]), { status: 200 }))) as unknown as typeof fetch
    const r: StoreResult<DownloadLink> = { ok: true, value: { url: 'https://a/clip.sx3mf', headers: { 'x-sx-download-grant': 'sxg_1' }, versionId: 'v', version: '1.0.0', fileName: 'clip.sx3mf' } }
    expect(await fetchModel(store(r), listing, grab)).toMatchObject({ ok: true, version: '1.0.0' })
    expect(sent?.headers).toEqual({ 'x-sx-download-grant': 'sxg_1' })
  })
  it('turns every failure into a message: a store that throws, a missing file, a dropped connection', async () => {
    const throwing = { download: async () => Promise.reject(new Error('Failed to fetch')) } as unknown as StoreClient
    expect(await fetchModel(throwing, listing, respond(200))).toMatchObject({ ok: false, reason: 'error', message: 'The download failed: Failed to fetch' })
    expect(await fetchModel(store(link('https://a/b')), listing, respond(400))).toMatchObject({ ok: false, message: 'The file for Clip is missing (400).' })
    const dropped = (async () => Promise.reject(new TypeError('network down'))) as unknown as typeof fetch
    expect(await fetchModel(store(link('https://a/clip.sx3mf')), listing, dropped)).toMatchObject({ ok: false, message: 'The download failed: network down' })
    expect(await fetchModel(store({ ok: false, code: 'unavailable', message: '' }), listing, respond(200))).toMatchObject({ ok: false, message: 'The download could not be started.' })
  })
  it('accepts sx3mf, 3mf and stl only', () => {
    expect(['a.sx3mf', 'b.3MF', 'c.stl', 'd.obj', 'e'].map(isLibraryFormat)).toEqual([true, true, true, false, false])
  })
})

describe('the design sheet', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })
  const creator = { id: 'c1', handle: 'maker', displayName: 'Maker', followers: 0, ownerId: 'u2', status: 'active', trusted: false, createdAt: '2026-06-01T00:00:00Z' } as Creator
  const current = { id: 'v2', version: '1.1.0', format: 'sx3mf' } as ListingVersion
  const item = { listing: { ...listing, creatorId: 'c1', slug: 'clip', license: 'cc-by', status: 'approved', tags: [], createdAt: '2026-06-01T00:00:00Z', currentVersion: current } as Listing, creator }
  function mount(download: StoreClient['download'], save = vi.fn(async (name: string) => ({ id: name, name, size: 1 }))) {
    const s = { download, session: async () => null, onSessionChange: () => () => {} } as unknown as StoreClient
    const host = { kind: 'web', capabilities: {}, store: s, files: { save } } as unknown as Host
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client }, createElement(HostContextProvider, { value: host }, createElement(Detail, { item }))))
    return save
  }
  const lastToast = () => get().toast

  it('toasts a download that fails anywhere: the store, the file or the save', async () => {
    set({ toast: null })
    mount(async () => Promise.reject(new Error('offline')))
    fireEvent.click(screen.getByRole('button', { name: /Download/ }))
    await waitFor(() => expect(lastToast()).toMatchObject({ tone: 'error', text: 'The download failed: offline' }))
    cleanup()
    set({ toast: null })
    vi.stubGlobal('fetch', async () => new Response('', { status: 400 }))
    mount(async () => link('https://a/clip.sx3mf'))
    fireEvent.click(screen.getByRole('button', { name: /Download/ }))
    await waitFor(() => expect(lastToast()).toMatchObject({ tone: 'error', text: 'The file for Clip is missing (400).' }))
    cleanup()
    set({ toast: null })
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1]), { status: 200 }))
    mount(
      async () => link('https://a/clip.sx3mf'),
      vi.fn(async () => Promise.reject(new Error('disk full'))),
    )
    fireEvent.click(screen.getByRole('button', { name: /Download/ }))
    await waitFor(() => expect(lastToast()).toMatchObject({ tone: 'error', text: 'The download failed: disk full' }))
  })

  it('toasts an Open that fails', async () => {
    set({ toast: null })
    mount(async () => ({ ok: false, code: 'unavailable', message: 'The download could not be started: Object not found' }))
    fireEvent.click(screen.getByRole('button', { name: /^Open in/ }))
    await waitFor(() => expect(lastToast()).toMatchObject({ tone: 'error', text: 'The download could not be started: Object not found' }))
  })

  it('shows the version the download handed out', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1]), { status: 200 }))
    mount(async () => link('https://a/clip.sx3mf'))
    expect(screen.getByText('1.1.0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Download/ }))
    await waitFor(() => expect(screen.getByText('1.0.0')).toBeTruthy())
    expect(screen.queryByText('1.1.0')).toBeNull()
  })
})

describe('website links', () => {
  const edition = { ...NEUTRAL, apps: { ...NEUTRAL.apps, web: { origin: 'https://slicerx.app' } } }
  it('builds them from the edition routes', () => {
    expect(signInUrl(edition)).toBe(`https://slicerx.app${edition.routes.login}?next=${encodeURIComponent(edition.routes.studio)}`)
    expect(dashboardUrl(edition)).toBe(`https://slicerx.app${edition.routes.dashboard}`)
    expect(creatorUrl(edition, 'ada lovelace')).toBe('https://slicerx.app/creators/ada%20lovelace')
  })
  it('links the privacy section', () => {
    expect(privacyUrl(edition, 'https://github.com/o/r/tree/abc')).toBe('https://github.com/o/r/blob/main/packages/store/README.md#privacy')
    expect(privacyUrl({ ...edition, legal: { ...edition.legal, privacy: 'https://slicerx.app/privacy' } }, 'x')).toBe('https://slicerx.app/privacy')
  })
})
