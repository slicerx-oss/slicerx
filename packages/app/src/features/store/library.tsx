// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Library: the free, moderated model library. Search, category and sort, a
// model's page with its creator, and a free download or Open in Prepare.
import type { Creator, ListingCard } from '@slicerx/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Button, Chip, Icon, Seg } from '@slicerx/ui'
import { LayerArt, LibrarySwitch, openModelBytes, setWorkspace, toast, useEdition, useHost, useTabLabel, openSettings } from '@slicerx/app'
import { coverFor, initials } from './art'
import { fetchModel, formatLabel } from './download'
import { CATEGORIES, setLibraryFilter, useLibraryFilter } from './filter'
import { detailQuery, listingsQuery, useSession, useStore } from './queries'
import { creatorUrl, dashboardUrl, openExternal, signInUrl } from './routes'
import { SignInNotice } from './signin'

const label = (c: string) => c.charAt(0).toUpperCase() + c.slice(1)

export function Library() {
  const store = useStore()
  const host = useHost()
  const edition = useEdition()
  const filter = useLibraryFilter()
  const { session } = useSession()
  const [text, setText] = useState(filter.query)
  const [selected, setSelected] = useState<string | null>(null)
  const list = useInfiniteQuery(listingsQuery(store, filter))
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const sel = items.find((i) => i.listing.id === selected) ?? items[0]

  useEffect(() => {
    const t = window.setTimeout(() => setLibraryFilter({ query: text }), 200)
    return () => window.clearTimeout(t)
  }, [text])

  return (
    <div className="feed library-browse">
      <div className="feed-bar">
        <LibrarySwitch />
        <div className="feed-search">
          <div className="search-in grow">
            <Icon name="search" />
            <label className="sr-only" htmlFor="models-search">
              Search models
            </label>
            <input id="models-search" className="bare" placeholder="Search by model, creator or tag" value={text} onChange={(e) => setText(e.currentTarget.value)} />
          </div>
        </div>
        <div className="feed-sort">
          <Seg
            label="Sort"
            size="sm"
            value={filter.sort}
            onChange={(sort) => setLibraryFilter({ sort })}
            options={[
              { value: 'new', label: 'Newest', icon: 'time' },
              { value: 'popular', label: 'Most printed', icon: 'plate' },
            ]}
          />
          {session ? (
            <Button size="sm" tip="account.open" icon="creator" onClick={() => openSettings('account')}>
              {session.displayName ?? session.handle ?? 'Account'}
            </Button>
          ) : (
            <Button size="sm" icon="creator" onClick={() => void openExternal(host, signInUrl(edition))}>
              Sign in
            </Button>
          )}
          <Button size="sm" variant="primary" icon="cloud-upload" onClick={() => void openExternal(host, dashboardUrl(edition))}>
            Upload
          </Button>
        </div>
        <div className="cats" role="radiogroup" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={filter.category === c} className="cat" onClick={() => setLibraryFilter({ category: c })}>
              {c === 'all' ? 'All' : label(c)}
            </button>
          ))}
        </div>
      </div>
      <div className="feed-body">
        <div className="feed-main">
          {!store ? <p className="app-empty">This build has no model library.</p> : null}
          {list.isPending && store ? <div className="drop skeleton" aria-busy="true" /> : null}
          {list.isError ? (
            <p className="app-err" role="alert">
              The library did not load: {list.error.message}{' '}
              <Button size="sm" onClick={() => void list.refetch()}>
                Try again
              </Button>
            </p>
          ) : null}
          {list.isSuccess && items.length === 0 ? <p className="app-empty">No models match. Try another word or category.</p> : null}
          {items.length ? (
            <section aria-labelledby="lib-grid-h">
              <h2 id="lib-grid-h" className="sec-h">
                {filter.category === 'all' ? 'All models' : label(filter.category)} <span className="sx-mono dim">{items.length}{list.hasNextPage ? '+' : ''}</span>
              </h2>
              <div className="grid lined">
                {items.map((i) => (
                  <Card key={i.listing.id} item={i} selected={sel?.listing.id === i.listing.id} onSelect={() => setSelected(i.listing.id)} />
                ))}
              </div>
              {list.hasNextPage ? (
                <div className="more">
                  <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    {list.isFetchingNextPage ? 'Loading' : 'Show more'}
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
        <aside className="feed-side" aria-label="Model details">
          {sel ? <Detail key={sel.listing.id} item={sel} /> : null}
        </aside>
      </div>
    </div>
  )
}

function Card({ item, selected, onSelect }: { item: ListingCard; selected: boolean; onSelect: () => void }) {
  const cover = coverFor(item.listing)
  const makes = item.listing.stats?.makes ?? 0
  return (
    <article className="card">
      <button type="button" className="card-art" aria-pressed={selected} onClick={onSelect} aria-label={`${item.listing.title}, details`}>
        {cover ? <img src={cover} alt="" loading="lazy" /> : <LayerArt seed={item.listing.slug} muted />}
      </button>
      <div className="card-b">
        <b>{item.listing.title}</b>
        <CreatorLink creator={item.creator} className="sx-small sx-muted" />
        {makes > 0 ? <span className="sx-mono sx-small sx-dim">{makes.toLocaleString('en-US')} printed</span> : null}
      </div>
    </article>
  )
}

/** The creator's name as a link to their page on the website. */
function CreatorLink({ creator, className }: { creator: Creator; className?: string }) {
  const host = useHost()
  const edition = useEdition()
  const href = creatorUrl(edition, creator.handle)
  return (
    <a
      className={className ? `creator-link ${className}` : 'creator-link'}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault()
        void openExternal(host, href)
      }}
    >
      {creator.displayName}
    </a>
  )
}

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h ? `${h} h ${m} min` : `${m} min`
}

function Detail({ item }: { item: ListingCard }) {
  const store = useStore()
  const tab = useTabLabel('prepare')
  const host = useHost()
  const edition = useEdition()
  const client = useQueryClient()
  const { session } = useSession()
  const { listing, creator } = item
  const detail = useQuery(detailQuery(store, listing.slug))
  const version = detail.data?.versions[0] ?? listing.currentVersion
  const cover = coverFor(listing)
  const [busy, setBusy] = useState<'open' | 'save' | null>(null)
  const [needSignIn, setNeedSignIn] = useState(false)
  const stats = listing.stats
  const profile = version?.printProfiles ? Object.entries(version.printProfiles)[0] : undefined
  const facts: [string, string][] = []
  if (version) facts.push(['Format', formatLabel(version.format)], ['Version', version.version])
  if (profile) facts.push(['Printer', profile[0]], ['Profile', profile[1].process])
  if (profile?.[1].timeS) facts.push(['Time', fmtTime(profile[1].timeS)])
  if (profile?.[1].grams) facts.push(['Filament', `${Math.round(profile[1].grams)} g`])

  const run = async (kind: 'open' | 'save') => {
    if (!store) return
    setBusy(kind)
    setNeedSignIn(false)
    try {
      const r = await fetchModel(store, listing)
      if (!r.ok) {
        if (r.reason === 'sign-in') setNeedSignIn(true)
        else toast(r.message, 'error')
        return
      }
      if (kind === 'open') {
        setWorkspace('prepare')
        await openModelBytes(host, r.name, r.bytes, { modelId: listing.id, creatorId: creator.id })
      } else {
        const ext = r.name.split('.').pop() ?? ''
        const saved = await host.files.save(r.name, r.bytes, { accept: [`.${ext}`] })
        if (saved) toast(`Saved ${saved.name}`, 'ok')
      }
    } finally {
      setBusy(null)
    }
  }

  const follow = async () => {
    if (!store) return
    if (!session) {
      setNeedSignIn(true)
      return
    }
    const r = creator.followedByMe ? await store.unfollow(creator.id) : await store.follow(creator.id)
    if (!r.ok) {
      if (r.code === 'not_signed_in') setNeedSignIn(true)
      else toast(r.message, 'error')
      return
    }
    toast(creator.followedByMe ? `Unfollowed ${creator.displayName}` : `Following ${creator.displayName}`, 'ok')
    void client.invalidateQueries({ queryKey: ['library'] })
  }

  return (
    <article className="lib-detail" aria-labelledby={`lib-${listing.id}`}>
      <div className="drop-art">{cover ? <img src={cover} alt={listing.title} /> : <LayerArt seed={listing.slug} layers={20} muted />}</div>
      <h2 id={`lib-${listing.id}`} className="sx-display">
        {listing.title}
      </h2>
      <div className="byline">
        <span className="av">{initials(creator.displayName)}</span>
        <CreatorLink creator={creator} />
      </div>
      {listing.description ? <p className="drop-desc">{listing.description}</p> : null}
      <div className="tags">
        <Chip mono>{listing.license.toUpperCase()}</Chip>
        {listing.tags.slice(0, 4).map((t) => (
          <Chip key={t}>{t}</Chip>
        ))}
      </div>
      {stats ? (
        <p className="sx-mono sx-small sx-dim">
          {stats.downloads.toLocaleString('en-US')} downloads, {stats.makes.toLocaleString('en-US')} printed, {stats.likes.toLocaleString('en-US')} likes
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
      {needSignIn ? <SignInNotice>Sign in to download models and follow creators. It is free.</SignInNotice> : null}
      <div className="stack8">
        <Button variant="primary" size="lg" full icon="prepare" disabled={busy !== null || !version} onClick={() => void run('open')}>
          {busy === 'open' ? 'Opening' : `Open in ${tab}`}
        </Button>
        <div className="row-btns">
          <Button icon="download" disabled={busy !== null || !version} onClick={() => void run('save')}>
            {busy === 'save' ? 'Downloading' : 'Download'}
          </Button>
          <Button icon="notification" pressed={Boolean(creator.followedByMe)} onClick={() => void follow()}>
            {creator.followedByMe ? 'Following' : 'Follow'}
          </Button>
        </div>
      </div>
      {!version ? <p className="sx-small sx-muted">This model has no file yet.</p> : null}
      <p className="sx-small sx-dim">
        <a href={creatorUrl(edition, creator.handle)} onClick={(e) => { e.preventDefault(); void openExternal(host, creatorUrl(edition, creator.handle)) }}>
          More from {creator.displayName}
        </a>
      </p>
    </article>
  )
}
