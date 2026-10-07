// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A creator's sheet: slides over the Library from the right with their banner,
// logo, stats, bio, pinned design, links and uploads. The view is pure so the
// creator page editor can show it as a live preview.
import type { CreatorLink, CreatorPage, Listing } from '@slicerx/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Icon } from '@slicerx/ui'
import { LayerArt, toast, useHost } from '@slicerx/app'
import { coverFor, initials } from './art'
import { LINK_KIND_INFO, linkText } from './links'
import { creatorPageQuery, LIBRARY_KEY, useSession, useStore } from './queries'
import { openExternal } from './routes'
import { closeSheet, openEditor, openListing } from './sheets'

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
export const count = (n: number): string => (n < 10_000 ? n.toLocaleString('en-US') : compact.format(n))

/** The creator's logo, or their initials when there is none or it does not load. */
export function CreatorAvatar({ name, url, size = 'md' }: { name: string; url?: string | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  return (
    <span className="cr-av" data-size={size} aria-hidden="true">
      {url && !broken ? <img src={url} alt="" onError={() => setBroken(true)} /> : initials(name) || name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** The banner image, or a quiet layered pattern seeded by the handle. */
export function CreatorBanner({ url, seed }: { url?: string | undefined; seed: string }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [url])
  return (
    <div className="cs-banner" aria-hidden="true">
      {url && !broken ? (
        <img src={url} alt="" onError={() => setBroken(true)} />
      ) : (
        <div className="cs-banner-art">
          <LayerArt seed={seed} layers={24} muted />
        </div>
      )}
    </div>
  )
}

export interface CreatorSheetViewProps {
  page: CreatorPage
  /** The signed-in member owns this page. */
  own?: boolean
  /** Shown in the editor: nothing is clickable and the sheet does not float. */
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
      <CreatorBanner url={creator.bannerUrl} seed={creator.handle} />
      {onClose ? (
        <button type="button" className="cs-close" aria-label="Close creator page" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      ) : null}
      <div className="cs-head">
        <CreatorAvatar name={creator.displayName} url={creator.logoUrl} size="lg" />
        <div className="cs-actions">
          {own ? (
            <Button size="sm" icon="rename" onClick={onEdit} disabled={preview}>
              Edit page
            </Button>
          ) : (
            <Button size="sm" variant={creator.followedByMe ? 'default' : 'primary'} icon="notification" pressed={Boolean(creator.followedByMe)} onClick={onFollow} disabled={preview || busy}>
              {creator.followedByMe ? 'Following' : 'Follow'}
            </Button>
          )}
        </div>
      </div>
      <div className="cs-id">
        <h2 className="cs-name">{creator.displayName || 'Your name'}</h2>
        <span className="cs-handle sx-mono">@{creator.handle || 'handle'}</span>
        {creator.tagline ? <p className="cs-tagline">{creator.tagline}</p> : null}
      </div>
      <dl className="cs-stats">
        <div>
          <dt>Designs</dt>
          <dd className="sx-mono">{count(designs)}</dd>
        </div>
        <div>
          <dt>Downloads</dt>
          <dd className="sx-mono">{count(downloads)}</dd>
        </div>
        <div>
          <dt>Followers</dt>
          <dd className="sx-mono">{count(creator.followers)}</dd>
        </div>
      </dl>
      <div className="cs-tabs" role="tablist" aria-label="Creator page">
        {tabBtn('about', 'About')}
        {tabBtn('uploads', <>Uploads <span className="sx-mono dim">{designs}</span></>)}
      </div>
      {tab === 'about' ? (
        <div className="cs-panel" role="tabpanel" id={`${ids}-about-panel`} aria-labelledby={`${ids}-about`}>
          {creator.bio ? <p className="cs-bio">{creator.bio}</p> : <p className="cs-bio dim">{own ? 'Add a few lines about what you make.' : 'No bio yet.'}</p>}
          {pinned ? (
            <section className="cs-sec" aria-label="Pinned design">
              <h3 className="cs-sec-h">
                <Icon name="pin" size={14} /> Pinned
              </h3>
              <DesignTile listing={pinned} wide onOpen={preview ? undefined : onOpenListing} />
            </section>
          ) : null}
          {links.length ? (
            <section className="cs-sec" aria-label="Links">
              <h3 className="cs-sec-h">Links</h3>
              <ul className="cs-links">
                {links.map((l) => (
                  <li key={l.id}>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cs-link"
                      tabIndex={preview ? -1 : undefined}
                      onClick={(e) => {
                        e.preventDefault()
                        if (!preview) onOpenLink?.(l)
                      }}
                    >
                      <Icon name={LINK_KIND_INFO[l.kind].icon} size={18} />
                      <span>{linkText(l)}</span>
                      {l.label && l.kind !== 'website' && l.kind !== 'other' && l.label.trim().toLowerCase() !== LINK_KIND_INFO[l.kind].label.toLowerCase() ? <span className="dim">{LINK_KIND_INFO[l.kind].label}</span> : null}
                      <Icon name="external" size={14} className="cs-link-out" />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="cs-panel" role="tabpanel" id={`${ids}-uploads-panel`} aria-labelledby={`${ids}-uploads`}>
          {listings.length ? (
            <div className="cs-grid">
              {listings.map((l) => (
                <DesignTile key={l.id} listing={l} onOpen={preview ? undefined : onOpenListing} />
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

function DesignTile({ listing, wide, onOpen }: { listing: Listing; wide?: boolean; onOpen?: ((l: Listing) => void) | undefined }) {
  const cover = coverFor(listing)
  const body = (
    <>
      <span className="cs-tile-art">{cover ? <img src={cover} alt="" loading="lazy" /> : <LayerArt seed={listing.slug} muted />}</span>
      <span className="cs-tile-b">
        <b>{listing.title}</b>
        {listing.stats ? (
          <span className="sx-mono dim">
            {count(listing.stats.downloads)} {listing.stats.downloads === 1 ? 'download' : 'downloads'}
          </span>
        ) : null}
      </span>
    </>
  )
  return onOpen ? (
    <button type="button" className="cs-tile" data-wide={wide ? true : undefined} onClick={() => onOpen(listing)}>
      {body}
    </button>
  ) : (
    <div className="cs-tile" data-wide={wide ? true : undefined}>
      {body}
    </div>
  )
}

/** The floating sheet over the Library for the creator with this handle. */
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

/** The right-side sheet frame: floats over the Library, closes on Escape or the scrim, and takes focus while open. */
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
