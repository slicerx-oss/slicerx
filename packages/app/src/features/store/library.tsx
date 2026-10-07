// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Library: the free, moderated model library. One featured design, then rows
// (most popular, recent, trending this week, new creators, based on your
// likes), each with See all for the full grid. Search, a category or the Saved
// filter show the grid too. Designs and creators open in a sheet on the right.
import type { Creator, Listing, ListingCard } from '@slicerx/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Chip, Icon, Seg } from '@slicerx/ui'
import { LayerArt, LibrarySwitch, openModelBytes, openSettings, setWorkspace, toast, useEdition, useHost } from '@slicerx/app'
import { coverFor } from './art'
import { CreatorEditorHost } from './creator-editor'
import { count, CreatorAvatar, CreatorSheet, Sheet } from './creator-sheet'
import { fetchModel, formatLabel } from './download'
import { CATEGORIES, DEFAULT_FILTER, setLibraryFilter, showsGrid, useLibraryFilter, type LibrarySort } from './filter'
import { detailQuery, LIBRARY_KEY, listingsQuery, myCreatorQuery, newCreatorsQuery, rowQuery, useSession, useStore } from './queries'
import { dashboardUrl, openExternal, signInUrl } from './routes'
import { pickFeatured, ROWS, withoutFeatured, type RowId } from './rows'
import { closeSheet, openCreator, openEditor, openListing, resetSheets, useLibrarySheets } from './sheets'
import { SignInNotice } from './signin'
import './library.css'

const label = (c: string) => c.charAt(0).toUpperCase() + c.slice(1)
const plural = (n: number, word: string) => `${count(n)} ${n === 1 ? word : `${word}s`}`

const SORT_TITLE: Record<LibrarySort, string> = { new: 'Recent', popular: 'Most popular', trending: 'Trending this week', liked: 'Based on your likes' }

export function Library() {
  const store = useStore()
  const filter = useLibraryFilter()
  const sheets = useLibrarySheets()
  const [text, setText] = useState(filter.query)

  useEffect(() => {
    const t = window.setTimeout(() => setLibraryFilter({ query: text }), 200)
    return () => window.clearTimeout(t)
  }, [text])
  useEffect(() => () => resetSheets(), [])

  return (
    <div className="feed library-browse lib">
      <LibraryBar text={text} setText={setText} />
      <div className="lib-body">{!store ? <p className="app-empty">This build has no model library.</p> : showsGrid(filter) ? <Grid onBack={() => setText('')} /> : <Rows />}</div>
      {sheets.creator ? <CreatorSheet key={sheets.creator} handle={sheets.creator} /> : null}
      {sheets.listing ? <ListingSheet key={sheets.listing} id={sheets.listing} /> : null}
      <CreatorEditorHost />
    </div>
  )
}

function LibraryBar({ text, setText }: { text: string; setText: (t: string) => void }) {
  const store = useStore()
  const host = useHost()
  const edition = useEdition()
  const filter = useLibraryFilter()
  const { session } = useSession()
  const mine = useQuery(myCreatorQuery(store, Boolean(session)))

  const upload = () => {
    if (session && mine.isSuccess && !mine.data) openEditor('upload')
    else void openExternal(host, dashboardUrl(edition))
  }

  return (
    <div className="feed-bar">
      <LibrarySwitch />
      <div className="feed-search">
        <div className="search-in grow">
          <Icon name="search" />
          <label className="sr-only" htmlFor="models-search">
            Search models
          </label>
          <input id="models-search" className="bare" type="search" placeholder="Search by model, creator or tag" value={text} onChange={(e) => setText(e.currentTarget.value)} />
        </div>
      </div>
      <div className="feed-sort">
        {session ? (
          <Button size="sm" tip="account.open" icon="creator" onClick={() => openSettings('account')}>
            {session.displayName ?? session.handle ?? 'Account'}
          </Button>
        ) : (
          <Button size="sm" icon="creator" onClick={() => void openExternal(host, signInUrl(edition))}>
            Sign in
          </Button>
        )}
        <Button size="sm" variant="primary" icon="cloud-upload" onClick={upload}>
          Upload
        </Button>
      </div>
      <div className="cats" role="group" aria-label="Filter">
        <button type="button" className="cat lib-saved" aria-pressed={filter.saved} onClick={() => setLibraryFilter({ saved: !filter.saved })}>
          <Icon name="bookmark" size={14} /> Saved
        </button>
        <span className="lib-cat-sep" aria-hidden="true" />
        {CATEGORIES.map((c) => (
          <button key={c} type="button" aria-pressed={filter.category === c} className="cat" onClick={() => setLibraryFilter({ category: c })}>
            {c === 'all' ? 'All' : label(c)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Featured design and the rows. */
function Rows() {
  const store = useStore()
  const { session } = useSession()
  const signedIn = Boolean(session)
  const trending = useQuery(rowQuery(store, 'trending', signedIn))
  const popular = useQuery(rowQuery(store, 'popular', signedIn))
  const featured = pickFeatured(trending.data, popular.data)
  const waiting = trending.isPending || popular.isPending
  return (
    <div className="lib-rows">
      {waiting ? <div className="lib-feat skeleton" aria-busy="true" /> : featured ? <Featured item={featured} /> : null}
      {popular.isError ? (
        <p className="app-err" role="alert">
          The library did not load: {popular.error.message}{' '}
          <Button size="sm" onClick={() => void popular.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {ROWS.map((r) =>
        r.id === 'new-creators' ? (
          <CreatorRow key={r.id} title={r.title} />
        ) : r.signedIn && !signedIn ? null : (
          <ListingRow key={r.id} row={r.id} title={r.title} sort={r.sort ?? 'new'} featured={featured} />
        ),
      )}
    </div>
  )
}

function RowFrame({ title, onSeeAll, children, id }: { title: string; onSeeAll?: () => void; children: ReactNode; id: string }) {
  const rail = useRef<HTMLDivElement>(null)
  const scroll = (dir: 1 | -1) => rail.current?.scrollBy({ left: dir * rail.current.clientWidth * 0.8, behavior: 'smooth' })
  return (
    <section className="lib-row" aria-labelledby={`${id}-h`}>
      <header className="lib-row-h">
        <h2 id={`${id}-h`} className="sec-h">
          {title}
        </h2>
        <div className="lib-row-tools">
          <Button size="sm" variant="ghost" icon="chevron-left" aria-label={`Scroll ${title} back`} className="lib-row-arrow" onClick={() => scroll(-1)} />
          <Button size="sm" variant="ghost" icon="chevron-right" aria-label={`Scroll ${title} forward`} className="lib-row-arrow" onClick={() => scroll(1)} />
          {onSeeAll ? (
            <Button size="sm" variant="ghost" onClick={onSeeAll}>
              See all
            </Button>
          ) : null}
        </div>
      </header>
      <div className="lib-rail" ref={rail} role="list">
        {children}
      </div>
    </section>
  )
}

function ListingRow({ row, title, sort, featured }: { row: RowId; title: string; sort: LibrarySort; featured: ListingCard | null }) {
  const store = useStore()
  const { session } = useSession()
  const q = useQuery(rowQuery(store, row, Boolean(session)))
  const items = withoutFeatured(q.data ?? [], featured)
  if (q.isError || (q.isSuccess && items.length === 0)) return null
  return (
    <RowFrame id={`lib-${row}`} title={title} onSeeAll={() => setLibraryFilter({ ...DEFAULT_FILTER, sort, view: 'grid' })}>
      {q.isPending
        ? Array.from({ length: 5 }, (_, i) => <div key={i} className="lib-rail-item lib-card skeleton" role="listitem" aria-hidden="true" />)
        : items.map((i) => (
            <div key={i.listing.id} role="listitem" className="lib-rail-item">
              <Card item={i} />
            </div>
          ))}
    </RowFrame>
  )
}

function CreatorRow({ title }: { title: string }) {
  const store = useStore()
  const q = useQuery(newCreatorsQuery(store))
  if (!q.isSuccess || q.data.length === 0) return null
  return (
    <RowFrame id="lib-new-creators" title={title}>
      {q.data.map((c) => (
        <div key={c.id} role="listitem" className="lib-rail-item lib-rail-creator">
          <CreatorCard creator={c} />
        </div>
      ))}
    </RowFrame>
  )
}

function CreatorCard({ creator }: { creator: Creator }) {
  const n = creator.listingCount ?? 0
  return (
    <button type="button" className="lib-creator" onClick={() => openCreator(creator.handle)}>
      <CreatorAvatar name={creator.displayName} url={creator.logoUrl} size="lg" />
      <b>{creator.displayName}</b>
      <span className="sx-mono sx-small dim">@{creator.handle}</span>
      <span className="sx-small dim">
        {plural(n, 'design')}
      </span>
    </button>
  )
}

/** The uploader as a chip that opens their creator sheet. */
function Uploader({ creator }: { creator: Creator }) {
  return (
    <button type="button" className="lib-uploader" onClick={() => openCreator(creator.handle)}>
      <CreatorAvatar name={creator.displayName} url={creator.logoUrl} size="sm" />
      <span>{creator.displayName}</span>
    </button>
  )
}

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h ? `${h} h ${m} min` : `${m} min`
}

/** Print time and filament from the creator's first tested profile. */
function printFacts(listing: Listing): { time?: string; grams?: string; printer?: string } {
  const p = listing.currentVersion?.printProfiles ? Object.entries(listing.currentVersion.printProfiles)[0] : undefined
  if (!p) return {}
  return {
    printer: p[0],
    ...(p[1].timeS ? { time: fmtTime(p[1].timeS) } : {}),
    ...(p[1].grams ? { grams: `${Math.round(p[1].grams)} g` } : {}),
  }
}

/** Save and unsave, with a sign-in nudge when signed out. */
function useSave(listing: Listing) {
  const store = useStore()
  const client = useQueryClient()
  const { session } = useSession()
  const [busy, setBusy] = useState(false)
  const saved = Boolean(listing.savedByMe)
  const toggle = async () => {
    if (!store) return
    if (!session) {
      toast('Sign in to save designs', 'info')
      return
    }
    setBusy(true)
    try {
      const r = await store.setSaved(listing.id, !saved)
      if (!r.ok) toast(r.message, 'error')
      else {
        toast(saved ? `Removed ${listing.title} from Saved` : `Saved ${listing.title}`, 'ok')
        await Promise.all([client.invalidateQueries({ queryKey: LIBRARY_KEY }), client.invalidateQueries({ queryKey: ['library-detail'] })])
      }
    } finally {
      setBusy(false)
    }
  }
  return { saved, busy, toggle }
}

/** Opens a design in Prepare. */
function useOpenInApp(item: ListingCard) {
  const store = useStore()
  const host = useHost()
  const [busy, setBusy] = useState(false)
  const [needSignIn, setNeedSignIn] = useState(false)
  const open = async () => {
    if (!store) return
    setBusy(true)
    setNeedSignIn(false)
    try {
      const r = await fetchModel(store, item.listing)
      if (!r.ok) {
        if (r.reason === 'sign-in') setNeedSignIn(true)
        else toast(r.message, 'error')
        return
      }
      setWorkspace('prepare')
      await openModelBytes(host, r.name, r.bytes, { modelId: item.listing.id, creatorId: item.creator.id })
    } finally {
      setBusy(false)
    }
  }
  return { open, busy, needSignIn }
}

function Featured({ item }: { item: ListingCard }) {
  const { listing, creator } = item
  const edition = useEdition()
  const cover = coverFor(listing)
  const facts = printFacts(listing)
  const save = useSave(listing)
  const openIn = useOpenInApp(item)
  const s = listing.stats
  const fact = (icon: Parameters<typeof Icon>[0]['name'], name: string, value: string) => (
    <div>
      <dt>
        <Icon name={icon} size={16} /> {name}
      </dt>
      <dd className="sx-mono">{value}</dd>
    </div>
  )
  return (
    <article className="lib-feat" aria-labelledby="lib-feat-h">
      <button type="button" className="lib-feat-art" onClick={() => openListing(listing.id)} aria-label={`${listing.title}, details`}>
        {cover ? <img src={cover} alt="" /> : <LayerArt seed={listing.slug} layers={28} />}
      </button>
      <div className="lib-feat-b">
        <span className="lib-eyebrow">Featured</span>
        <h2 id="lib-feat-h" className="sx-display lib-feat-title">
          {listing.title}
        </h2>
        <Uploader creator={creator} />
        {listing.description ? <p className="lib-feat-desc">{listing.description}</p> : null}
        <dl className="lib-facts">
          {facts.time ? fact('time', 'Print time', facts.time) : null}
          {facts.grams ? fact('weight', 'Filament', facts.grams) : null}
          {s ? (
            <>
              {fact('download', 'Downloads', count(s.downloads))}
              {fact('printer', 'Printed', count(s.makes))}
              {fact('heart', 'Likes', count(s.likes))}
            </>
          ) : null}
        </dl>
        {openIn.needSignIn ? <SignInNotice>Sign in to download models. It is free.</SignInNotice> : null}
        <div className="lib-feat-actions">
          <Button variant="primary" size="lg" icon="prepare" disabled={openIn.busy || !listing.currentVersion} onClick={() => void openIn.open()}>
            {openIn.busy ? 'Opening' : `Open in ${edition.brand.shortName}`}
          </Button>
          <Button size="lg" icon="bookmark" pressed={save.saved} disabled={save.busy} onClick={() => void save.toggle()}>
            {save.saved ? 'Saved' : 'Save'}
          </Button>
        </div>
      </div>
    </article>
  )
}

function Card({ item }: { item: ListingCard }) {
  const { listing, creator } = item
  const cover = coverFor(listing)
  const save = useSave(listing)
  const s = listing.stats
  return (
    <article className="lib-card">
      <div className="lib-card-art">
        <button type="button" className="card-art" onClick={() => openListing(listing.id)} aria-label={`${listing.title}, details`}>
          {cover ? <img src={cover} alt="" loading="lazy" /> : <LayerArt seed={listing.slug} muted />}
        </button>
        <button type="button" className="lib-save" aria-pressed={save.saved} aria-label={save.saved ? `Remove ${listing.title} from Saved` : `Save ${listing.title}`} disabled={save.busy} onClick={() => void save.toggle()}>
          <Icon name="bookmark" size={16} />
        </button>
      </div>
      <div className="card-b">
        <b className="lib-card-title">{listing.title}</b>
        <Uploader creator={creator} />
        {s ? (
          <span className="sx-mono sx-small sx-dim">
            {plural(s.downloads, 'download')}, {plural(s.likes, 'like')}
          </span>
        ) : null}
      </div>
    </article>
  )
}

/** The full sorted grid: See all, a search, a category or the Saved filter. */
function Grid({ onBack }: { onBack: () => void }) {
  const store = useStore()
  const filter = useLibraryFilter()
  const { session } = useSession()
  const list = useInfiniteQuery(listingsQuery(store, filter, Boolean(session)))
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const q = filter.query.trim()
  const heading = filter.saved ? 'Saved' : q ? `Results for ${q}` : filter.category !== 'all' ? label(filter.category) : SORT_TITLE[filter.sort]
  const sortOptions: { value: LibrarySort; label: string }[] = [
    { value: 'popular', label: 'Popular' },
    { value: 'new', label: 'Recent' },
    { value: 'trending', label: 'Trending' },
    ...(session ? [{ value: 'liked' as const, label: 'For you' }] : []),
  ]
  return (
    <section className="lib-grid" aria-labelledby="lib-grid-h">
      <header className="lib-grid-h">
        <Button
          size="sm"
          variant="ghost"
          icon="arrow-left"
          onClick={() => {
            onBack()
            setLibraryFilter({ ...DEFAULT_FILTER })
          }}
        >
          Library
        </Button>
        <h2 id="lib-grid-h" className="sec-h">
          {heading}{' '}
          <span className="sx-mono dim">
            {items.length}
            {list.hasNextPage ? '+' : ''}
          </span>
        </h2>
        <Seg label="Sort" size="sm" value={filter.sort} onChange={(sort) => setLibraryFilter({ sort })} options={sortOptions} />
      </header>
      {filter.saved && !session ? <SignInNotice>Sign in to save designs and find them here.</SignInNotice> : null}
      {list.isPending ? <div className="drop skeleton" aria-busy="true" /> : null}
      {list.isError ? (
        <p className="app-err" role="alert">
          The library did not load: {list.error.message}{' '}
          <Button size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {list.isSuccess && items.length === 0 ? <p className="app-empty">{filter.saved ? 'Nothing saved yet. Use Save on any design to keep it here.' : 'No models match. Try another word or category.'}</p> : null}
      {items.length ? (
        <div className="lib-grid-cards">
          {items.map((i) => (
            <Card key={i.listing.id} item={i} />
          ))}
        </div>
      ) : null}
      {list.hasNextPage ? (
        <div className="more">
          <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {list.isFetchingNextPage ? 'Loading' : 'Show more'}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

/** A design's sheet: the model's details with Open, Download, Save and its uploader. */
function ListingSheet({ id }: { id: string }) {
  const store = useStore()
  const detail = useQuery(detailQuery(store, id))
  return (
    <Sheet label={detail.data ? detail.data.listing.title : 'Model details'} onClose={closeSheet} className="lib-sheet-model">
      <button type="button" className="cs-close" aria-label="Close model details" onClick={closeSheet}>
        <Icon name="close" size={18} />
      </button>
      {detail.isPending ? <div className="cs-loading skeleton" aria-busy="true" /> : null}
      {detail.isSuccess && !detail.data ? <p className="app-empty cs-pad">This model is not available.</p> : null}
      {detail.data ? <Detail item={{ listing: detail.data.listing, creator: detail.data.creator }} /> : null}
    </Sheet>
  )
}

function Detail({ item }: { item: ListingCard }) {
  const store = useStore()
  const host = useHost()
  const edition = useEdition()
  const { listing, creator } = item
  const version = listing.currentVersion
  const cover = coverFor(listing)
  const save = useSave(listing)
  const openIn = useOpenInApp(item)
  const [busy, setBusy] = useState(false)
  const [needSignIn, setNeedSignIn] = useState(false)
  const stats = listing.stats
  const p = printFacts(listing)
  const facts: [string, string][] = []
  if (version) facts.push(['Format', formatLabel(version.format)], ['Version', version.version])
  if (p.printer) facts.push(['Printer', p.printer])
  if (p.time) facts.push(['Print time', p.time])
  if (p.grams) facts.push(['Filament', p.grams])

  const download = async () => {
    if (!store) return
    setBusy(true)
    setNeedSignIn(false)
    try {
      const r = await fetchModel(store, listing)
      if (!r.ok) {
        if (r.reason === 'sign-in') setNeedSignIn(true)
        else toast(r.message, 'error')
        return
      }
      const ext = r.name.split('.').pop() ?? ''
      const saved = await host.files.save(r.name, r.bytes, { accept: [`.${ext}`] })
      if (saved) toast(`Saved ${saved.name}`, 'ok')
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="lib-detail cs-pad" aria-labelledby={`lib-${listing.id}`}>
      <div className="drop-art">{cover ? <img src={cover} alt={listing.title} /> : <LayerArt seed={listing.slug} layers={20} muted />}</div>
      <h2 id={`lib-${listing.id}`} className="sx-display">
        {listing.title}
      </h2>
      <Uploader creator={creator} />
      {listing.description ? <p className="drop-desc">{listing.description}</p> : null}
      <div className="tags">
        <Chip mono>{listing.license.toUpperCase()}</Chip>
        {listing.tags.slice(0, 4).map((t) => (
          <Chip key={t}>{t}</Chip>
        ))}
      </div>
      {stats ? (
        <p className="sx-mono sx-small sx-dim">
          {plural(stats.downloads, 'download')}, {count(stats.makes)} printed, {plural(stats.likes, 'like')}
        </p>
      ) : null}
      {facts.length ? (
        <dl className="used">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {needSignIn || openIn.needSignIn ? <SignInNotice>Sign in to download models. It is free.</SignInNotice> : null}
      <div className="stack8">
        <Button variant="primary" size="lg" full icon="prepare" disabled={openIn.busy || busy || !version} onClick={() => void openIn.open()}>
          {openIn.busy ? 'Opening' : `Open in ${edition.brand.shortName}`}
        </Button>
        <div className="row-btns">
          <Button icon="download" disabled={busy || openIn.busy || !version} onClick={() => void download()}>
            {busy ? 'Downloading' : 'Download'}
          </Button>
          <Button icon="bookmark" pressed={save.saved} disabled={save.busy} onClick={() => void save.toggle()}>
            {save.saved ? 'Saved' : 'Save'}
          </Button>
        </div>
      </div>
      {!version ? <p className="sx-small sx-muted">This model has no file yet.</p> : null}
      <button type="button" className="lib-more" onClick={() => openCreator(creator.handle)}>
        More from {creator.displayName}
      </button>
    </article>
  )
}
