// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Vault: the free, moderated model library. One featured design, then rows
// (most popular, recent, trending, new creators, based on your likes) that
// scroll sideways, each with See all for the full grid. Search, Saved or a
// quick filter show the grid too. Designs and creators open in a sheet on the
// right.
import type { Creator, Listing, ListingCard } from '@slicerx/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Chip, Icon, Menu, MenuAnchor, MenuItem, Seg } from '@slicerx/ui'
import { LayerArt, LibrarySwitch, openModelBytes, openSettings, setWorkspace, toast, useEdition, useHost } from '@slicerx/app'
import { coverFor } from './art'
import { CreatorEditorHost } from './creator-editor'
import { count, CreatorAvatar, CreatorSheet, plural, printFacts, Sheet } from './creator-sheet'
import { fetchModel, formatLabel } from './download'
import { CATEGORIES, DEFAULT_FILTER, setLibraryFilter, showsGrid, useLibraryFilter, type LibrarySort } from './filter'
import { detailQuery, LIBRARY_KEY, listingsQuery, myCreatorQuery, newCreatorsQuery, rowQuery, savedCountQuery, useSession, useStore } from './queries'
import { pickFeatured, ROWS, withoutFeatured, type RowId } from './rows'
import { closeSheet, openCreator, openEditor, openListing, openReview, openUpload, resetSheets, useLibrarySheets } from './sheets'
import { UploadHost } from './upload'
import { canReview, ReviewHost } from './review'
import { SignInDialog, SignInNotice } from './signin'
import './library.css'

const label = (c: string) => c.charAt(0).toUpperCase() + c.slice(1)

const SORT_TITLE: Record<LibrarySort, string> = { new: 'Recent', popular: 'Most popular', trending: 'Trending', liked: 'Based on your likes' }

/** "2 h ago", "3 d ago", "2 w ago". */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (m < 60) return `${Math.max(1, m)} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d} d ago`
  const w = Math.round(d / 7)
  if (w < 9) return `${w} w ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

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
      <VaultBar />
      <div className="lib-body">
        <Filters text={text} setText={setText} />
        {!store ? <p className="app-empty">This build has no Vault.</p> : showsGrid(filter) ? <Grid onBack={() => setText('')} /> : <Rows />}
      </div>
      {sheets.creator ? <CreatorSheet key={sheets.creator} handle={sheets.creator} /> : null}
      {sheets.listing ? <ListingSheet key={sheets.listing} id={sheets.listing} /> : null}
      <CreatorEditorHost />
      <UploadHost />
      <ReviewHost />
    </div>
  )
}

/** Community or Mine, the account menu and Upload. */
function VaultBar() {
  const store = useStore()
  const { session } = useSession()
  const mine = useQuery(myCreatorQuery(store, Boolean(session)))
  const [menu, setMenu] = useState(false)
  const [signIn, setSignIn] = useState(false)
  const close = (fn: () => void) => () => {
    setMenu(false)
    fn()
  }

  const upload = () => {
    if (session && mine.isSuccess && !mine.data) openEditor('upload')
    else if (session) openUpload('form')
    else setSignIn(true)
  }

  return (
    <div className="lib-bar">
      <LibrarySwitch />
      <div className="lib-bar-tools">
        {session ? (
          <MenuAnchor>
            <Button size="sm" icon="creator" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              {session.displayName ?? session.handle ?? 'Account'}
            </Button>
            <Menu open={menu} onClose={() => setMenu(false)} label="Account" align="end">
              <MenuItem icon="cloud-upload" onClick={close(() => openUpload('list'))}>
                Uploads
              </MenuItem>
              <MenuItem icon="bookmark" onClick={close(() => setLibraryFilter({ saved: true }))}>
                Saved
              </MenuItem>
              <MenuItem icon="creator" onClick={close(() => openEditor('edit'))}>
                Creator page
              </MenuItem>
              {canReview(session.role) ? (
                <MenuItem icon="queue-review" onClick={close(openReview)}>
                  Review queue
                </MenuItem>
              ) : null}
              <MenuItem icon="settings" onClick={close(() => openSettings('account'))}>
                Account settings
              </MenuItem>
            </Menu>
          </MenuAnchor>
        ) : (
          <Button size="sm" icon="creator" onClick={() => setSignIn(true)}>
            Sign in
          </Button>
        )}
        <Button size="sm" variant="primary" icon="cloud-upload" onClick={upload}>
          Upload
        </Button>
      </div>
      <SignInDialog open={signIn && !session} onClose={() => setSignIn(false)} />
    </div>
  )
}

/** Search, Everything, Saved with its count, then the quick filters. They narrow everything below. */
function Filters({ text, setText }: { text: string; setText: (t: string) => void }) {
  const store = useStore()
  const filter = useLibraryFilter()
  const { session } = useSession()
  const saved = useQuery(savedCountQuery(store, Boolean(session)))
  const everything = !filter.saved && filter.category === 'all'
  return (
    <div className="lib-filters" role="toolbar" aria-label="Filter the Vault">
      <div className="search-in lib-search">
        <Icon name="search" />
        <label className="sr-only" htmlFor="models-search">
          Search models
        </label>
        <input id="models-search" className="bare" type="search" placeholder="Search designs and creators" value={text} onChange={(e) => setText(e.currentTarget.value)} />
      </div>
      <button type="button" className="lib-chip" aria-pressed={everything} onClick={() => setLibraryFilter({ saved: false, category: 'all' })}>
        Everything
      </button>
      <button type="button" className="lib-chip" aria-pressed={filter.saved} onClick={() => setLibraryFilter({ saved: !filter.saved })}>
        <Icon name="bookmark" size={13} /> Saved
        {saved.data ? <span className="lib-chip-n">{saved.data}</span> : null}
      </button>
      <span className="lib-sep" aria-hidden="true" />
      {CATEGORIES.filter((c) => c !== 'all').map((c) => (
        <button key={c} type="button" className="lib-chip" aria-pressed={filter.category === c} onClick={() => setLibraryFilter({ category: filter.category === c ? 'all' : c })}>
          {label(c)}
        </button>
      ))}
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
      {waiting ? <div className="lib-hero skeleton" aria-busy="true" /> : featured ? <Featured item={featured} weekly={Boolean(trending.data?.length)} /> : null}
      {popular.isError ? (
        <p className="app-err" role="alert">
          The Vault did not load: {popular.error.message}{' '}
          <Button size="sm" onClick={() => void popular.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {ROWS.map((r) =>
        r.id === 'new-creators' ? (
          <CreatorRow key={r.id} title={r.title} note={r.note} />
        ) : r.signedIn && !signedIn ? null : (
          <ListingRow key={r.id} row={r.id} title={r.title} note={r.note} sort={r.sort ?? 'new'} featured={featured} />
        ),
      )}
    </div>
  )
}

function RowFrame({ title, note, onSeeAll, children, id }: { title: string; note: string; onSeeAll?: () => void; children: ReactNode; id: string }) {
  return (
    <section className="lib-row" aria-labelledby={`${id}-h`}>
      <header className="lib-row-h">
        <h2 id={`${id}-h`} className="lib-row-t">
          {title}
        </h2>
        <span className="lib-row-note">{note}</span>
        {onSeeAll ? (
          <button type="button" className="lib-see" onClick={onSeeAll}>
            See all
          </button>
        ) : null}
      </header>
      <div className="lib-railwrap">
        <div className="lib-rail" role="list">
          {children}
        </div>
      </div>
    </section>
  )
}

function ListingRow({ row, title, note, sort, featured }: { row: RowId; title: string; note: string; sort: LibrarySort; featured: ListingCard | null }) {
  const store = useStore()
  const { session } = useSession()
  const q = useQuery(rowQuery(store, row, Boolean(session)))
  const items = withoutFeatured(q.data ?? [], featured)
  if (q.isError || (q.isSuccess && items.length === 0)) return null
  const ranked = row === 'popular' || row === 'trending'
  return (
    <RowFrame id={`lib-${row}`} title={title} note={note} onSeeAll={() => setLibraryFilter({ ...DEFAULT_FILTER, sort, view: 'grid' })}>
      {q.isPending
        ? Array.from({ length: 5 }, (_, i) => <div key={i} className="lib-rail-item lib-mini skeleton" role="listitem" aria-hidden="true" />)
        : items.map((i, n) => (
            <div key={i.listing.id} role="listitem" className="lib-rail-item">
              <Card item={i} rank={ranked ? n + 1 : undefined} stat={row === 'recent' ? 'age' : 'downloads'} />
            </div>
          ))}
    </RowFrame>
  )
}

function CreatorRow({ title, note }: { title: string; note: string }) {
  const store = useStore()
  const q = useQuery(newCreatorsQuery(store))
  if (!q.isSuccess || q.data.length === 0) return null
  return (
    <RowFrame id="lib-new-creators" title={title} note={note}>
      {q.data.map((c) => (
        <div key={c.id} role="listitem" className="lib-rail-item">
          <CreatorCard creator={c} />
        </div>
      ))}
    </RowFrame>
  )
}

function CreatorCard({ creator }: { creator: Creator }) {
  return (
    <button type="button" className="lib-creator" onClick={() => openCreator(creator.handle)}>
      <CreatorAvatar name={creator.displayName} url={creator.logoUrl} size="lg" />
      <span className="min0">
        <b>{creator.displayName}</b>
        <small>@{creator.handle}</small>
      </span>
      <span className="lib-first">{creator.firstPublishedAt ? `First upload ${ago(creator.firstPublishedAt)}` : plural(creator.listingCount ?? 0, 'design')}</span>
    </button>
  )
}

/** The uploader as a chip that opens their creator sheet. */
function Uploader({ creator }: { creator: Creator }) {
  return (
    <button type="button" className="lib-who" onClick={() => openCreator(creator.handle)}>
      <CreatorAvatar name={creator.displayName} url={creator.logoUrl} size="sm" />
      <span>{creator.displayName}</span>
    </button>
  )
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

/** Like and unlike. Likes feed the counts, Trending and Based on your likes. */
function useLike(listing: Listing) {
  const store = useStore()
  const client = useQueryClient()
  const { session } = useSession()
  const [busy, setBusy] = useState(false)
  const liked = Boolean(listing.likedByMe)
  const toggle = async () => {
    if (!store) return
    if (!session) {
      toast('Sign in to like designs', 'info')
      return
    }
    setBusy(true)
    try {
      const r = liked ? await store.unlike(listing.id) : await store.like(listing.id)
      if (!r.ok) toast(r.message, 'error')
      else await Promise.all([client.invalidateQueries({ queryKey: LIBRARY_KEY }), client.invalidateQueries({ queryKey: ['library-detail'] })])
    } finally {
      setBusy(false)
    }
  }
  return { liked, busy, toggle }
}

/** Opens a design in Prepare. */
function useOpenInApp(item: ListingCard, onFetched?: (version: string, name: string) => void) {
  const store = useStore()
  const host = useHost()
  const { session } = useSession()
  const [busy, setBusy] = useState(false)
  const [needSignIn, setNeedSignIn] = useState(false)
  const open = async () => {
    if (!store) return
    setBusy(true)
    setNeedSignIn(false)
    try {
      const r = await fetchModel(store, item.listing, fetch, Boolean(session?.creatorId && session.creatorId === item.creator.id))
      if (!r.ok) {
        if (r.reason === 'sign-in') setNeedSignIn(true)
        else toast(r.message, 'error')
        return
      }
      onFetched?.(r.version, r.name)
      setWorkspace('prepare')
      // Errors opening the file are toasted there.
      await openModelBytes(host, r.name, r.bytes, { modelId: item.listing.id, creatorId: item.creator.id }, { fresh: true })
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : `Could not open ${item.listing.title}.`, 'error')
    } finally {
      setBusy(false)
    }
  }
  return { open, busy, needSignIn }
}

function StatIcons({ listing }: { listing: Listing }) {
  const s = listing.stats
  if (!s) return null
  return (
    <div className="lib-stats">
      <span aria-label="Downloads">
        <Icon name="download" size={13} />
        {count(s.downloads)}
      </span>
      <span>
        <Icon name="printer" size={13} />
        {count(s.makes)} printed
      </span>
      <span aria-label="Likes">
        <Icon name="heart" size={13} />
        {count(s.likes)}
      </span>
    </div>
  )
}

function Featured({ item, weekly }: { item: ListingCard; weekly: boolean }) {
  const { listing, creator } = item
  const edition = useEdition()
  const cover = coverFor(listing)
  const facts = printFacts(listing)
  const save = useSave(listing)
  const openIn = useOpenInApp(item)
  return (
    <article className="lib-hero" aria-labelledby="lib-feat-h">
      <button type="button" className="lib-hero-art" onClick={() => openListing(listing.id)} aria-label={`${listing.title}, details`}>
        {cover ? <img src={cover} alt="" /> : <LayerArt seed={listing.slug} layers={28} />}
      </button>
      <div className="lib-hero-copy">
        <span className="lib-kicker">{weekly ? 'Featured this week' : 'Featured'}</span>
        <h2 id="lib-feat-h" className="lib-hero-t">
          {listing.title}
        </h2>
        <div>
          <Uploader creator={creator} />
        </div>
        {listing.description ? <p className="lib-hero-d">{listing.description}</p> : null}
        {facts.time || facts.grams ? (
          <dl className="lib-spec">
            {facts.time ? (
              <div>
                <dt>Print time</dt>
                <dd>{facts.time}</dd>
              </div>
            ) : null}
            {facts.grams ? (
              <div>
                <dt>Filament</dt>
                <dd>{facts.grams}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <StatIcons listing={listing} />
        {openIn.needSignIn ? <SignInNotice>Sign in to download models. It is free.</SignInNotice> : null}
        <div className="lib-hero-actions">
          <Button variant="primary" icon="prepare" disabled={openIn.busy || !listing.currentVersion} onClick={() => void openIn.open()}>
            {openIn.busy ? 'Opening' : `Open in ${edition.brand.shortName}`}
          </Button>
          <Button icon="bookmark" pressed={save.saved} disabled={save.busy} onClick={() => void save.toggle()}>
            {save.saved ? 'Saved' : 'Save'}
          </Button>
        </div>
      </div>
    </article>
  )
}

function Card({ item, rank, stat = 'downloads' }: { item: ListingCard; rank?: number | undefined; stat?: 'downloads' | 'age' }) {
  const { listing, creator } = item
  const cover = coverFor(listing)
  const save = useSave(listing)
  const s = listing.stats
  return (
    <article className="lib-mini">
      <div className="lib-mini-art">
        <button type="button" className="lib-thumb" onClick={() => openListing(listing.id)} aria-label={`${listing.title}, details`}>
          {cover ? <img src={cover} alt="" loading="lazy" /> : <LayerArt seed={listing.slug} muted />}
        </button>
        <button type="button" className="lib-save" aria-pressed={save.saved} aria-label={save.saved ? `Remove ${listing.title} from Saved` : `Save ${listing.title}`} disabled={save.busy} onClick={() => void save.toggle()}>
          <Icon name="bookmark" size={15} />
        </button>
      </div>
      <h3 className="lib-mini-t">
        {rank ? <span className="lib-rank">{rank}</span> : null}
        {listing.title}
      </h3>
      <div className="lib-mini-meta">
        <Uploader creator={creator} />
        {stat === 'age' ? (
          <span className="lib-why">{ago(listing.publishedAt ?? listing.createdAt)}</span>
        ) : s ? (
          <span className="lib-stats">
            <span aria-label="Downloads">
              <Icon name="download" size={13} />
              {count(s.downloads)}
            </span>
          </span>
        ) : null}
      </div>
    </article>
  )
}

/** The full sorted grid: See all, a search, a quick filter or Saved. */
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
          Vault
        </Button>
        <h2 id="lib-grid-h" className="lib-row-t">
          {heading}{' '}
          <span className="lib-row-note">
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
          The Vault did not load: {list.error.message}{' '}
          <Button size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {list.isSuccess && items.length === 0 ? <p className="app-empty">{filter.saved ? 'Nothing saved yet. Use Save on any design to keep it here.' : 'No models match. Try another word or filter.'}</p> : null}
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
        <Icon name="close" size={16} />
      </button>
      {detail.isPending ? <div className="cs-loading skeleton" aria-busy="true" /> : null}
      {detail.isSuccess && !detail.data ? <p className="app-empty cs-pad">This model is not available.</p> : null}
      {detail.data ? <Detail item={{ listing: detail.data.listing, creator: detail.data.creator }} /> : null}
    </Sheet>
  )
}

export function Detail({ item }: { item: ListingCard }) {
  const store = useStore()
  const host = useHost()
  const edition = useEdition()
  const { session } = useSession()
  const { listing, creator } = item
  const version = listing.currentVersion
  const cover = coverFor(listing)
  const save = useSave(listing)
  // Once a download or Open hands out a file, the sheet shows that version and format.
  const [got, setGot] = useState<{ version: string; format: string } | null>(null)
  const onFetched = (v: string, name: string) => setGot({ version: v, format: name.split('.').pop()?.toUpperCase() ?? '' })
  const like = useLike(listing)
  const openIn = useOpenInApp(item, onFetched)
  const [busy, setBusy] = useState(false)
  const [needSignIn, setNeedSignIn] = useState(false)
  const p = printFacts(listing)
  const facts: [string, string][] = []
  if (got) facts.push(['Format', got.format || formatLabel(version?.format)], ['Version', got.version])
  else if (version) facts.push(['Format', formatLabel(version.format)], ['Version', version.version])
  if (p.printer) facts.push(['Printer', p.printer])
  if (p.time) facts.push(['Print time', p.time])
  if (p.grams) facts.push(['Filament', p.grams])

  const download = async () => {
    if (!store) return
    setBusy(true)
    setNeedSignIn(false)
    try {
      const r = await fetchModel(store, listing, fetch, Boolean(session?.creatorId && session.creatorId === creator.id))
      if (!r.ok) {
        if (r.reason === 'sign-in') setNeedSignIn(true)
        else toast(r.message, 'error')
        return
      }
      onFetched(r.version, r.name)
      const ext = r.name.split('.').pop() ?? ''
      const saved = await host.files.save(r.name, r.bytes, { accept: [`.${ext}`] })
      if (saved) toast(`Saved ${saved.name}`, 'ok')
    } catch (e) {
      toast(e instanceof Error && e.message ? `The download failed: ${e.message}` : 'The download failed.', 'error')
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
      <div>
        <Uploader creator={creator} />
      </div>
      {listing.description ? <p className="drop-desc">{listing.description}</p> : null}
      <div className="tags">
        <Chip mono>{listing.license.toUpperCase()}</Chip>
        {listing.tags.slice(0, 4).map((t) => (
          <Chip key={t}>{t}</Chip>
        ))}
      </div>
      <StatIcons listing={listing} />
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
            {busy ? 'Downloading' : 'Download .sx3mf'}
          </Button>
          <Button icon="bookmark" pressed={save.saved} disabled={save.busy} onClick={() => void save.toggle()}>
            {save.saved ? 'Saved' : 'Save'}
          </Button>
          <Button icon="heart" pressed={like.liked} disabled={like.busy} onClick={() => void like.toggle()}>
            {like.liked ? 'Liked' : 'Like'}
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
