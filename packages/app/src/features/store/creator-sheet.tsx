// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A creator's sheet: docks over the Vault from the right with their banner,
// logo, tags, stats, bio, pinned design, links and uploads. The view is pure so
// the creator page editor can show it as a live preview.
import type { Creator, CreatorLink, CreatorPage, Listing } from '@slicerx/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@slicerx/ui'
import { LayerArt, toast, useHost } from '@slicerx/app'
import { DrawingArt } from './drawing-art'
import { coverFor, initials } from './art'
import { LINK_KIND_INFO, linkSubtitle, linkTitle } from './links'
import { creatorPageQuery, LIBRARY_KEY, useSession, useStore } from './queries'
import { openExternal } from './routes'
import { closeSheet, openEditor, openListing } from './sheets'

/** Counts as the Vault shows them: 4,812 up to ten thousand, then 21.6k and 1.2m. */
export function count(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US')
  const [v, unit] = n < 1_000_000 ? [n / 1000, 'k'] : [n / 1_000_000, 'm']
  return `${v.toFixed(1).replace(/\.0$/, '')}${unit}`
}

export const plural = (n: number, word: string): string => `${count(n)} ${n === 1 ? word : `${word}s`}`

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h ? `${h} h ${m} min` : `${m} min`
}

/** Print time and filament from the creator's first tested profile. */
export function printFacts(listing: Listing): { time?: string; grams?: string; printer?: string } {
  const p = listing.currentVersion?.printProfiles ? Object.entries(listing.currentVersion.printProfiles)[0] : undefined
  if (!p) return {}
  return {
    printer: p[0],
    ...(p[1].timeS ? { time: fmtTime(p[1].timeS) } : {}),
    ...(p[1].grams ? { grams: `${Math.round(p[1].grams)} g` } : {}),
  }
}

/** The creator's logo, or their initials when there is none or it does not load. `ring`: the pink creator ring. */
export function CreatorAvatar({ name, url, size = 'md', ring }: { name: string; url?: string | undefined; size?: 'sm' | 'md' | 'lg' | 'xl'; ring?: boolean }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  return (
    <span className="cr-av" data-size={size} data-ring={ring ? true : undefined} aria-hidden="true">
      {url && !broken ? <img src={url} alt="" onError={() => setBroken(true)} /> : initials(name) || name.slice(0, 1).toUpperCase() || '?'}
    </span>
  )
}

/** The banner image, or a quiet layered pattern seeded by the handle. */
export function CreatorBanner({ url, seed }: { url?: string | undefined; seed: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  return (
    <div className="cs-cover" aria-hidden="true">
      {url && !broken ? (
        <img src={url} alt="" onError={() => setBroken(true)} />
      ) : (
        <div className="cs-cover-art">
          <LayerArt seed={seed} layers={24} muted />
        </div>
      )}
    </div>
  )
}

/** Creator in pink, then the tags staff set, in purple. */
export function CreatorTags({ creator }: { creator: Pick<Creator, 'badges'> }) {
  return (
    <div className="cs-roles">
      <span className="cs-role">Creator</span>
      {(creator.badges ?? []).map((b) => (
        <span key={b} className="cs-role" data-staff="">
          {b}
        </span>
      ))}
    </div>
  )
}

export interface CreatorSheetViewProps {
  page: CreatorPage
  /** The signed-in member owns this page. */
  own?: boolean
  /** Shown in the editor: nothing is clickable. */
  preview?: boolean
  onClose?: () => void
  onFollow?: () => void
  onEdit?: () => void
  onOpenListing?: (l: Listing) => void
  onOpenLink?: (l: CreatorLink) => void
  busy?: boolean
}

export function CreatorSheetView({ page, own, preview, onClose, onFollow, onEdit, onOpenListing, onOpenLink, busy }: CreatorSheetViewProps) {
  const { creator, links, listings } = page
  const [tab, setTab] = useState<'about' | 'uploads'>('about')
  const ids = useId()
  const pinned = page.featured[0]
  const downloads = listings.reduce((n, l) => n + (l.stats?.downloads ?? 0), 0)
  const designs = creator.listingCount ?? listings.length
  const name = creator.displayName || 'Your name'
  const latest = listings.filter((l) => l.id !== pinned?.id).slice(0, 4)
  const open = preview ? undefined : onOpenListing
  const tabBtn = (id: 'about' | 'uploads', label: ReactNode) => (
    <button
      type="button"
      role="tab"
      id={`${ids}-${id}`}
      aria-selected={tab === id}
      aria-controls={`${ids}-${id}-panel`}
      tabIndex={tab === id ? 0 : -1}
      className="cs-tab"
      onClick={() => setTab(id)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const next = tab === 'about' ? 'uploads' : 'about'
          setTab(next)
          document.getElementById(`${ids}-${next}`)?.focus()
        }
      }}
    >
      {label}
    </button>
  )
  return (
    <div className="cs" data-preview={preview ? true : undefined}>
      <CreatorBanner url={creator.bannerUrl} seed={creator.handle || 'creator'} />
      {onClose ? (
        <button type="button" className="cs-close" aria-label="Close creator page" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      ) : null}
      <div className="cs-id">
        <CreatorAvatar name={name} url={creator.logoUrl} size="xl" ring />
        <div className="cs-line">
          <div className="min0">
            <h2 className="cs-name">{name}</h2>
            <div className="cs-handle">
              @{creator.handle || 'handle'}
              {creator.location ? ` · ${creator.location}` : ''}
            </div>
          </div>
          {own ? (
            <button type="button" className="cs-btn" onClick={onEdit} disabled={preview}>
              Edit page
            </button>
          ) : (
            <button type="button" className="cs-btn" data-pink="" aria-pressed={Boolean(creator.followedByMe)} onClick={onFollow} disabled={preview || busy}>
              {creator.followedByMe ? 'Following' : 'Follow'}
            </button>
          )}
        </div>
        <CreatorTags creator={creator} />
        <div className="cs-stats">
          <span>{plural(designs, 'design')}</span>
          <span>{plural(downloads, 'download')}</span>
          <span>{plural(creator.followers, 'follower')}</span>
        </div>
      </div>
      <div className="cs-tabs" role="tablist" aria-label="Creator page">
        {tabBtn('about', 'About')}
        {tabBtn('uploads', <>Uploads {designs}</>)}
      </div>
      {tab === 'about' ? (
        <div className="cs-panel" role="tabpanel" id={`${ids}-about-panel`} aria-labelledby={`${ids}-about`}>
          {creator.bio ? <p className="cs-bio">{creator.bio}</p> : <p className="cs-bio dim">{own ? 'Add a few lines about what you make.' : 'No bio yet.'}</p>}
          {pinned ? (
            <section className="cs-kit" aria-label="Pinned design">
              <h3 className="cs-kit-h">Pinned</h3>
              <Pinned listing={pinned} by={name} onOpen={open} />
            </section>
          ) : null}
          {links.length ? (
            <section className="cs-kit" aria-label="Creator links">
              <h3 className="cs-kit-h">Creator links</h3>
              <ul className="cs-links">
                {links.map((l, i) => (
                  <li key={l.id}>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cs-link"
                      data-feature={i === 0 ? true : undefined}
                      tabIndex={preview ? -1 : undefined}
                      onClick={(e) => {
                        e.preventDefault()
                        if (!preview) onOpenLink?.(l)
                      }}
                    >
                      <Icon name={LINK_KIND_INFO[l.kind].icon} size={22} />
                      <span className="min0">
                        <b>{linkTitle(l)}</b>
                        <small>{linkSubtitle(l, name)}</small>
                      </span>
                      <span className="cs-link-go">Open</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {latest.length ? (
            <section className="cs-kit" aria-label="Latest uploads">
              <h3 className="cs-kit-h">Latest uploads</h3>
              <div className="cs-two">
                {latest.map((l) => (
                  <Thumb key={l.id} listing={l} onOpen={open} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="cs-panel" role="tabpanel" id={`${ids}-uploads-panel`} aria-labelledby={`${ids}-uploads`}>
          {listings.length ? (
            <div className="cs-two" data-titled="">
              {listings.map((l) => (
                <Thumb key={l.id} listing={l} titled onOpen={open} />
              ))}
            </div>
          ) : (
            <p className="cs-bio dim">No public designs yet.</p>
          )}
        </div>
      )}
    </div>
  )
}

function Art({ listing }: { listing: Listing }) {
  const cover = coverFor(listing)
  return <span className="cs-art">{cover ? <img src={cover} alt="" loading="lazy" /> : <DrawingArt seed={listing.slug} />}</span>
}

function Pinned({ listing, by, onOpen }: { listing: Listing; by: string; onOpen?: ((l: Listing) => void) | undefined }) {
  const f = printFacts(listing)
  const facts = [f.time, f.grams].filter(Boolean).join(' · ')
  const body = (
    <>
      <Art listing={listing} />
      <span className="min0">
        <span className="cs-pin-label">Pinned by {by}</span>
        <b>{listing.title}</b>
        {facts ? <small>{facts}</small> : null}
        {listing.stats ? <span className="cs-stats">{plural(listing.stats.downloads, 'download')}</span> : null}
      </span>
    </>
  )
  return onOpen ? (
    <button type="button" className="cs-pinned" onClick={() => onOpen(listing)}>
      {body}
    </button>
  ) : (
    <div className="cs-pinned">{body}</div>
  )
}

function Thumb({ listing, titled, onOpen }: { listing: Listing; titled?: boolean; onOpen?: ((l: Listing) => void) | undefined }) {
  const body = (
    <>
      <Art listing={listing} />
      {titled ? <b className="cs-thumb-t">{listing.title}</b> : <span className="sr-only">{listing.title}</span>}
    </>
  )
  return onOpen ? (
    <button type="button" className="cs-thumb" onClick={() => onOpen(listing)}>
      {body}
    </button>
  ) : (
    <div className="cs-thumb">{body}</div>
  )
}

/** The sheet over the Vault for the creator with this handle. */
export function CreatorSheet({ handle }: { handle: string }) {
  const store = useStore()
  const host = useHost()
  const client = useQueryClient()
  const { session } = useSession()
  const page = useQuery(creatorPageQuery(store, handle))
  const [busy, setBusy] = useState(false)
  const own = Boolean(session && page.data && page.data.creator.ownerId === session.userId)

  const follow = async () => {
    const c = page.data?.creator
    if (!store || !c) return
    if (!session) {
      toast('Sign in to follow creators', 'info')
      return
    }
    setBusy(true)
    try {
      const r = c.followedByMe ? await store.unfollow(c.id) : await store.follow(c.id)
      if (!r.ok) toast(r.message, 'error')
      else void client.invalidateQueries({ queryKey: LIBRARY_KEY })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet label={page.data ? `${page.data.creator.displayName}, creator page` : 'Creator page'} onClose={closeSheet}>
      {page.isPending ? <div className="cs-loading skeleton" aria-busy="true" /> : null}
      {page.isError ? (
        <p className="app-err cs-pad" role="alert">
          This page did not load: {page.error.message}
        </p>
      ) : null}
      {page.isSuccess && !page.data ? <p className="app-empty cs-pad">This creator page is not available.</p> : null}
      {page.data ? (
        <CreatorSheetView
          page={page.data}
          own={own}
          busy={busy}
          onClose={closeSheet}
          onFollow={() => void follow()}
          onEdit={() => openEditor('edit')}
          onOpenListing={(l) => openListing(l.id)}
          onOpenLink={(l) => void openExternal(host, l.url)}
        />
      ) : null}
    </Sheet>
  )
}

/** The right-side sheet frame: docks over the Vault, closes on Escape or the scrim, and takes focus while open. */
export function Sheet({ label, onClose, children, className }: { label: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      before?.focus?.()
    }
  }, [onClose])
  return (
    <div className="lib-sheet-layer">
      <div className="lib-scrim" aria-hidden="true" onClick={onClose} />
      <aside ref={ref} className={className ? `lib-sheet ${className}` : 'lib-sheet'} role="dialog" aria-modal="false" aria-label={label} tabIndex={-1}>
        {children}
      </aside>
    </div>
  )
}
