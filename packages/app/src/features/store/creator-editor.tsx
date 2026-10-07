// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creator page editor: banner, logo, name, handle, location, bio, pinned
// design and links, with the creator sheet beside it as a live preview and a
// save bar that stays in view. Opens from the account menu, Edit page on your
// own sheet, and Upload when you have no page yet.
import type { Creator, CreatorImageKind, CreatorLinkInput, CreatorLinkKind, CreatorPage, Listing, Session, StoreClient } from '@slicerx/contracts'
import { CREATOR_BIO_MAX, validateCreatorLink, validateHandle } from '@slicerx/store/validate'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Icon } from '@slicerx/ui'
import { LayerArt, toast, useEdition, useHost } from '@slicerx/app'
import { coverFor } from './art'
import { CreatorAvatar, CreatorSheetView, CreatorTags } from './creator-sheet'
import { LINK_KIND_INFO, LINK_KINDS } from './links'
import { creatorPageQuery, LIBRARY_KEY, myCreatorQuery, useSession, useStore } from './queries'
import { closeEditor, openCreator, openUpload, useLibrarySheets } from './sheets'

/** Longest bio, as the database takes it; a sheet reads best short. */
export const BIO_MAX = CREATOR_BIO_MAX
export const NAME_MAX = 40
export const LOCATION_MAX = 40
/** Links a page shows. The database allows 12; the sheet stays readable with 8. */
export const LINKS_MAX = 8
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Largest stored size: banners 1800 by 600, logos 512 square. Bigger pictures are scaled down before upload. */
const IMAGE_BOX: Record<CreatorImageKind, [number, number]> = { banner: [1800, 600], logo: [512, 512], cover: [1600, 1200] }

interface LinkDraft extends CreatorLinkInput {
  key: string
}

/** An image the creator picked: kept as bytes until Save, shown from an object URL meanwhile. */
export interface PendingImage {
  bytes: Uint8Array
  contentType: string
  preview: string
}

/** An image field: unchanged, replaced by a new pick, or removed. */
type ImageState = { kind: 'keep' } | { kind: 'new'; image: PendingImage } | { kind: 'remove' }

export interface EditorDraft {
  handle: string
  displayName: string
  location: string
  bio: string
  pinnedId: string | null
  links: LinkDraft[]
  banner: ImageState
  logo: ImageState
}

let linkKey = 0
const newKey = () => `l${++linkKey}`

/** A handle suggestion from the member's account: their handle, or their name in lowercase words. */
export function suggestHandle(session: Pick<Session, 'handle' | 'displayName'> | null): string {
  const from = session?.handle || session?.displayName || ''
  const h = from
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return h.length >= 3 ? h : ''
}

export function initialDraft(page: CreatorPage | null, session: Pick<Session, 'handle' | 'displayName'> | null): EditorDraft {
  const c = page?.creator
  return {
    handle: c?.handle ?? suggestHandle(session),
    displayName: c?.displayName ?? session?.displayName ?? '',
    location: c?.location ?? '',
    bio: c?.bio ?? '',
    pinnedId: page?.featured[0]?.id ?? null,
    links: (page?.links ?? []).map((l) => ({ key: l.id, kind: l.kind, url: l.url, ...(l.label ? { label: l.label } : {}) })),
    banner: { kind: 'keep' },
    logo: { kind: 'keep' },
  }
}

/** True when the draft differs from what was loaded. */
export function draftChanged(d: EditorDraft, base: EditorDraft): boolean {
  const plain = (x: EditorDraft) => JSON.stringify({ ...x, links: x.links.map(({ kind, label, url }) => ({ kind, label: label ?? '', url })), banner: x.banner.kind, logo: x.logo.kind })
  return plain(d) !== plain(base)
}

/** Problems that block saving, keyed by field. Empty when the draft can be saved. */
export function draftErrors(d: EditorDraft, handleFixed: boolean): Record<string, string> {
  const e: Record<string, string> = {}
  if (!handleFixed) {
    const h = validateHandle(d.handle)
    if (!h.ok) e.handle = h.message
  }
  const name = d.displayName.trim()
  if (name.length < 1) e.displayName = 'Enter the name people see'
  else if (name.length > NAME_MAX) e.displayName = `Names can be at most ${NAME_MAX} characters`
  if (d.location.trim().length > LOCATION_MAX) e.location = `Locations can be at most ${LOCATION_MAX} characters`
  if (d.bio.length > BIO_MAX) e.bio = `Bios can be at most ${BIO_MAX} characters`
  if (d.links.length > LINKS_MAX) e.links = `A creator page shows at most ${LINKS_MAX} links`
  const seen = new Set<string>()
  for (const l of d.links) {
    const r = validateCreatorLink(l)
    if (!r.ok) e[`link:${l.key}`] = r.message.replace(`A ${l.kind} link`, `A ${LINK_KIND_INFO[l.kind].label} link`)
    else if (seen.has(r.value.url)) e[`link:${l.key}`] = 'This address is already on the page'
    else seen.add(r.value.url)
  }
  return e
}

/** The page as the sheet will show it after Save, for the preview. */
export function previewPage(d: EditorDraft, page: CreatorPage | null, own: Listing[], session: Session | null): CreatorPage {
  const base: Creator = page?.creator ?? {
    id: 'preview',
    handle: d.handle,
    displayName: d.displayName,
    followers: 0,
    ownerId: session?.userId ?? '',
    status: 'active',
    trusted: false,
    createdAt: new Date(0).toISOString(),
  }
  const image = (s: ImageState, current: string | undefined) => (s.kind === 'new' ? s.image.preview : s.kind === 'remove' ? undefined : current)
  const bannerUrl = image(d.banner, base.bannerUrl)
  const logoUrl = image(d.logo, base.logoUrl)
  const { bannerUrl: _b, logoUrl: _l, bio: _bio, location: _loc, ...rest } = base
  const approved = page?.listings ?? own.filter((l) => l.status === 'approved')
  const pinned = approved.find((l) => l.id === d.pinnedId)
  return {
    creator: {
      ...rest,
      handle: d.handle,
      displayName: d.displayName.trim(),
      ...(d.bio.trim() ? { bio: d.bio.trim() } : {}),
      ...(d.location.trim() ? { location: d.location.trim() } : {}),
      ...(bannerUrl ? { bannerUrl } : {}),
      ...(logoUrl ? { logoUrl } : {}),
      listingCount: approved.length,
    },
    links: d.links.flatMap((l, position) => {
      const r = validateCreatorLink(l)
      return r.ok ? [{ id: l.key, kind: r.value.kind, url: r.value.url, position, ...(r.value.label ? { label: r.value.label } : {}) }] : []
    }),
    featured: pinned ? [pinned] : [],
    listings: approved,
  }
}

/** Scales a picked image into its box as WebP. Falls back to the original bytes where the browser cannot. */
export async function prepareImage(file: File, kind: CreatorImageKind): Promise<PendingImage | string> {
  if (!IMAGE_TYPES.includes(file.type)) return 'Use a PNG, JPEG or WebP image'
  const original = new Uint8Array(await file.arrayBuffer())
  let out: { bytes: Uint8Array; type: string } = { bytes: original, type: file.type }
  try {
    const bmp = await createImageBitmap(file)
    const [bw, bh] = IMAGE_BOX[kind]
    const scale = Math.min(1, bw / bmp.width, bh / bmp.height)
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.86))
    if (blob && blob.type === 'image/webp' && (scale < 1 || blob.size < original.byteLength)) out = { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/webp' }
  } catch {
    // keep the original
  }
  if (out.bytes.byteLength > IMAGE_MAX_BYTES) return 'Images can be at most 5 MB'
  return { bytes: out.bytes, contentType: out.type, preview: URL.createObjectURL(new Blob([out.bytes.slice().buffer], { type: out.type })) }
}

/**
 * Saves the draft in order: the page itself, then images, links and the pinned design. Stops at the first failure, and
 * then removes the images it uploaded that the page does not use, so a failed save leaves nothing behind in storage.
 */
export async function saveDraft(store: StoreClient, d: EditorDraft, page: CreatorPage | null): Promise<{ ok: true; creator: Creator } | { ok: false; message: string }> {
  const uploaded: string[] = []
  const failed = async (message: string): Promise<{ ok: false; message: string }> => {
    // Best effort: the store keeps an image the saved page shows.
    await Promise.all(uploaded.map((url) => store.removeCreatorImage(url).catch(() => undefined)))
    return { ok: false, message }
  }
  try {
    const text = { handle: page?.creator.handle ?? d.handle, displayName: d.displayName.trim(), bio: d.bio.trim() || null, location: d.location.trim() || null }
    const first = await store.saveCreator(text)
    if (!first.ok) return await failed(first.message)
    let creator = first.value
    const urls: { logoUrl?: string | null; bannerUrl?: string | null } = {}
    for (const kind of ['banner', 'logo'] as const) {
      const s = kind === 'banner' ? d.banner : d.logo
      const key = kind === 'banner' ? 'bannerUrl' : 'logoUrl'
      if (s.kind === 'remove') urls[key] = null
      if (s.kind === 'new') {
        const up = await store.uploadCreatorImage({ kind, bytes: s.image.bytes, contentType: s.image.contentType })
        if (!up.ok) return await failed(`The ${kind} did not upload: ${up.message}`)
        uploaded.push(up.value)
        urls[key] = up.value
      }
    }
    if (Object.keys(urls).length) {
      const again = await store.saveCreator({ ...text, ...urls })
      if (!again.ok) return await failed(again.message)
      creator = again.value
    }
    // The images are on the page now; a later failure leaves them in use.
    uploaded.length = 0
    const links = await store.setCreatorLinks(d.links.map(({ kind, label, url }) => ({ kind, url, ...(label?.trim() ? { label: label.trim() } : {}) })))
    if (!links.ok) return { ok: false, message: links.message }
    const featured = (page?.featured ?? []).map((l) => l.id)
    const oldPinned = featured[0] ?? null
    if (d.pinnedId !== oldPinned) {
      const rest = featured.filter((id) => id !== d.pinnedId && id !== oldPinned)
      const next = d.pinnedId ? [d.pinnedId, ...rest] : rest
      const r = await store.setFeatured(next.slice(0, 6))
      if (!r.ok) return { ok: false, message: r.message }
    }
    return { ok: true, creator }
  } catch (e) {
    return failed(e instanceof Error && e.message ? `The page did not save: ${e.message}` : 'The page did not save.')
  }
}

/** The editor, when the Vault asked for it. */
export function CreatorEditorHost() {
  const { editor } = useLibrarySheets()
  return editor ? <CreatorEditor why={editor} /> : null
}

/** The editor's frame: covers the Vault with a title bar, takes focus, and closes on Escape. */
export function Frame({ title, onClose, actions, children }: { title: string; onClose: () => void; actions?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      before?.focus?.()
    }
  }, [onClose])
  return (
    <div ref={ref} className="ce-frame" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <header className="ce-bar">
        <h2 className="ce-title">{title}</h2>
        <div className="ce-bar-tools">
          {actions}
          <button type="button" className="cs-close" data-inline="" aria-label="Close the creator page editor" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>
      {children}
    </div>
  )
}

function CreatorEditor({ why }: { why: 'edit' | 'upload' }) {
  const store = useStore()
  const { session, ready: sessionReady } = useSession()
  const mine = useQuery(myCreatorQuery(store, Boolean(session)))
  const page = useQuery(creatorPageQuery(store, mine.data?.handle ?? null))
  const own = useQuery({ queryKey: ['library', 'my-listings', session?.userId], queryFn: async () => (store && session ? store.myListings() : []), enabled: Boolean(store && session) })
  const ready = sessionReady && (!session || (mine.isSuccess && (!mine.data || page.isSuccess)))
  if (sessionReady && !session) {
    return (
      <Frame title="Set up your creator page" onClose={closeEditor}>
        <p className="cs-pad">Sign in to make a creator page.</p>
      </Frame>
    )
  }
  if (!ready || !session) {
    return (
      <Frame title="Creator page" onClose={closeEditor}>
        <div className="ce-loading skeleton" aria-busy="true" />
      </Frame>
    )
  }
  return <EditorForm key={mine.data?.id ?? 'new'} why={why} session={session} page={page.data ?? null} own={own.data ?? []} />
}

function EditorForm({ why, session, page, own }: { why: 'edit' | 'upload'; session: Session; page: CreatorPage | null; own: Listing[] }) {
  const store = useStore()
  const host = useHost()
  const edition = useEdition()
  const client = useQueryClient()
  const ids = useId()
  const base = useMemo(() => initialDraft(page, session), [page, session])
  const [draft, setDraft] = useState(base)
  const [touched, setTouched] = useState<Set<string>>(() => new Set())
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const handleFixed = Boolean(page)
  const errors = useMemo(() => draftErrors(draft, handleFixed), [draft, handleFixed])
  const dirty = draftChanged(draft, base)
  const shown = (k: string) => (tried || touched.has(k) ? errors[k] : undefined)
  const touch = (k: string) => setTouched((t) => new Set(t).add(k))
  const preview = useMemo(() => previewPage(draft, page, own, session), [draft, page, own, session])
  const approved = page?.listings ?? own.filter((l) => l.status === 'approved')
  const upload = why === 'upload'
  const title = page ? 'Creator page' : 'Set up your creator page'

  // Object URLs for picked images go when the editor closes.
  const urls = useRef<string[]>([])
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), [])

  const set = (patch: Partial<EditorDraft>) => {
    setSaveError(null)
    setDraft((d) => ({ ...d, ...patch }))
  }
  const setLink = (key: string, patch: Partial<LinkDraft>) => {
    setSaveError(null)
    setDraft((d) => ({ ...d, links: d.links.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
  }
  const moveLink = (key: string, to: number) =>
    setDraft((d) => {
      const i = d.links.findIndex((l) => l.key === key)
      if (i < 0 || to < 0 || to >= d.links.length || to === i) return d
      const links = [...d.links]
      const [l] = links.splice(i, 1)
      if (l) links.splice(to, 0, l)
      return { ...d, links }
    })

  const pick = async (kind: CreatorImageKind, file: File | undefined) => {
    if (!file) return
    setImageError(null)
    const r = await prepareImage(file, kind)
    if (typeof r === 'string') {
      setImageError(r)
      return
    }
    urls.current.push(r.preview)
    set({ [kind]: { kind: 'new', image: r } } as Partial<EditorDraft>)
  }


  const save = async () => {
    setTried(true)
    if (!store || Object.keys(errors).length) return
    setBusy(true)
    setSaveError(null)
    try {
      const r = await saveDraft(store, draft, page)
      if (!r.ok) {
        setSaveError(r.message)
        toast(r.message, 'error')
        return
      }
      await client.invalidateQueries({ queryKey: LIBRARY_KEY })
      void client.invalidateQueries({ queryKey: ['session'] })
      toast(page ? 'Creator page saved' : 'Creator page created', 'ok')
      closeEditor()
      if (upload) openUpload('form')
      else openCreator(r.creator.handle)
    } finally {
      setBusy(false)
    }
  }

  const current = (kind: CreatorImageKind) => (kind === 'banner' ? page?.creator.bannerUrl : page?.creator.logoUrl)
  const state = (kind: CreatorImageKind) => (kind === 'banner' ? draft.banner : draft.logo)
  const has = (kind: CreatorImageKind) => state(kind).kind === 'new' || (state(kind).kind === 'keep' && Boolean(current(kind)))
  const imageButtons = (kind: CreatorImageKind, label: string) => (
    <div className="ce-ops">
      <label className="ce-file">
        <input type="file" accept={IMAGE_TYPES.join(',')} className="sr-only" aria-label={`${has(kind) ? 'Change' : 'Upload'} ${label}`} onChange={(e) => { void pick(kind, e.currentTarget.files?.[0]); e.currentTarget.value = '' }} />
        <span aria-hidden="true">{has(kind) ? `Change ${label}` : `Upload ${label}`}</span>
      </label>
      {has(kind) ? (
        <button type="button" className="ce-file" onClick={() => set({ [kind]: { kind: 'remove' } } as Partial<EditorDraft>)} aria-label={`Remove ${label}`}>
          Remove
        </button>
      ) : null}
    </div>
  )

  const linksErr = shown('links')
  const stateText = busy ? 'Saving' : saveError ? `Not saved: ${saveError}` : dirty ? 'Unsaved changes' : page ? 'All changes saved' : 'Not saved yet'

  return (
    <Frame
      title={title}
      onClose={closeEditor}
      actions={
        page ? (
          <Button size="sm" onClick={() => { closeEditor(); openCreator(page.creator.handle) }}>
            View my sheet
          </Button>
        ) : null
      }
    >
      <div className="ce">
        <div className="ce-col">
          <form
            className="ce-form"
            aria-label="Creator page details"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            {upload && !page ? <p className="ce-intro">Your uploads show on your creator page, so set it up first. You can change any of it later.</p> : null}
            <fieldset className="ce-set">
              <legend>Banner and logo</legend>
              <div className="ce-banner">
                {preview.creator.bannerUrl ? <img src={preview.creator.bannerUrl} alt="Current banner" /> : <span className="ce-banner-art" aria-hidden="true"><LayerArt seed={draft.handle || 'creator'} layers={24} muted /></span>}
                {imageButtons('banner', 'banner')}
              </div>
              <span className="ce-hint">JPG, PNG or WebP up to 5 MB, at least 1500 by 500. Shown behind your logo at the top of your sheet.</span>
              <div className="ce-logo">
                <CreatorAvatar name={draft.displayName || 'You'} url={preview.creator.logoUrl} size="xl" ring />
                <div className="ce-logo-b">
                  {imageButtons('logo', 'logo')}
                  <span className="ce-hint">Square, at least 400 by 400. Cropped to a circle.</span>
                </div>
              </div>
              {imageError ? (
                <p className="ce-err" role="alert">
                  {imageError}
                </p>
              ) : null}
            </fieldset>

            <fieldset className="ce-set">
              <legend>Who you are</legend>
              <div className="ce-two">
                <div className="ce-field">
                  <label htmlFor={`${ids}-name`}>Display name</label>
                  <input className="ce-in" id={`${ids}-name`} value={draft.displayName} maxLength={NAME_MAX} onChange={(e) => set({ displayName: e.currentTarget.value })} onBlur={() => touch('displayName')} aria-invalid={Boolean(shown('displayName'))} />
                  {shown('displayName') ? <span className="ce-err">{shown('displayName')}</span> : null}
                </div>
                <div className="ce-field">
                  <label htmlFor={`${ids}-handle`}>Handle</label>
                  <div className="ce-prefix">
                    <span aria-hidden="true">@</span>
                    <input
                      className="ce-in"
                      id={`${ids}-handle`}
                      value={draft.handle}
                      placeholder="your-name"
                      readOnly={handleFixed}
                      aria-readonly={handleFixed}
                      aria-describedby={`${ids}-handle-h`}
                      onChange={(e) => set({ handle: e.currentTarget.value.toLowerCase() })}
                      onBlur={() => touch('handle')}
                      aria-invalid={Boolean(shown('handle'))}
                    />
                  </div>
                  <span className="ce-hint" id={`${ids}-handle-h`}>
                    {handleFixed ? 'Fixed once your page exists, so links to it keep working.' : '3 to 32 lowercase letters, digits or hyphens. It cannot be changed later.'}
                  </span>
                  {shown('handle') ? <span className="ce-err">{shown('handle')}</span> : null}
                </div>
              </div>
              <div className="ce-field">
                <label htmlFor={`${ids}-place`}>
                  Location <span className="ce-hint">optional</span>
                </label>
                <input className="ce-in" id={`${ids}-place`} value={draft.location} maxLength={LOCATION_MAX} onChange={(e) => set({ location: e.currentTarget.value })} />
              </div>
              <div className="ce-field">
                <label htmlFor={`${ids}-bio`}>Bio</label>
                <textarea className="ce-in ce-ta" id={`${ids}-bio`} value={draft.bio} maxLength={BIO_MAX} rows={5} onChange={(e) => set({ bio: e.currentTarget.value })} onBlur={() => touch('bio')} aria-invalid={Boolean(shown('bio'))} aria-describedby={`${ids}-bio-n`} />
                <span className="ce-count" id={`${ids}-bio-n`}>
                  {draft.bio.length} of {BIO_MAX}
                </span>
              </div>
              <div className="ce-tags">
                <span className="ce-hint">Tags on your sheet come from your account and are set by the {edition.brand.shortName} team:</span>
                <CreatorTags creator={page?.creator ?? {}} />
              </div>
            </fieldset>

            <fieldset className="ce-set">
              <legend>Pinned design</legend>
              <span className="ce-hint">{approved.length ? 'One of your approved uploads, shown first on your sheet.' : 'Your designs can be pinned once they are approved.'}</span>
              {approved.length ? (
                <div className="ce-picks">
                  {approved.map((l) => {
                    const cover = coverFor(l)
                    return (
                      <button key={l.id} type="button" className="ce-pick" aria-pressed={draft.pinnedId === l.id} onClick={() => set({ pinnedId: draft.pinnedId === l.id ? null : l.id })}>
                        <span className="cs-art">{cover ? <img src={cover} alt="" /> : <LayerArt seed={l.slug} muted />}</span>
                        <span className="ce-pick-t">{l.title}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </fieldset>

            <fieldset className="ce-set">
              <legend>Creator links</legend>
              <span className="ce-hint">Up to {LINKS_MAX}. The first one is highlighted, so put the link you most want people to open on top. Drag to reorder.</span>
              {draft.links.length ? (
                <div className="ce-lhead" aria-hidden="true">
                  <span />
                  <span>Site</span>
                  <span>Label</span>
                  <span>Link</span>
                  <span />
                </div>
              ) : null}
              <ol className="ce-links">
                {draft.links.map((l, i) => {
                  const err = shown(`link:${l.key}`)
                  return (
                    <li
                      key={l.key}
                      className="ce-link"
                      data-drag={dragKey === l.key ? true : undefined}
                      onDragOver={(e) => {
                        if (dragKey) e.preventDefault()
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        if (dragKey) moveLink(dragKey, i)
                        setDragKey(null)
                      }}
                    >
                      <div className="ce-lrow">
                        <button
                          type="button"
                          className="ce-grip"
                          draggable
                          aria-label={`Move link ${i + 1}. Use the up and down arrow keys.`}
                          onDragStart={(e) => {
                            setDragKey(l.key)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragEnd={() => setDragKey(null)}
                          onKeyDown={(e) => {
                            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                              e.preventDefault()
                              moveLink(l.key, i + (e.key === 'ArrowUp' ? -1 : 1))
                            }
                          }}
                        >
                          <Icon name="more" size={14} />
                        </button>
                        <span className="ce-selectwrap">
                          <select className="ce-in" aria-label={`Link ${i + 1} site`} value={l.kind} onChange={(e) => setLink(l.key, { kind: e.currentTarget.value as CreatorLinkKind })}>
                            {LINK_KINDS.map((k) => (
                              <option key={k} value={k}>
                                {LINK_KIND_INFO[k].label}
                              </option>
                            ))}
                          </select>
                        </span>
                        <input className="ce-in" aria-label={`Link ${i + 1} label`} placeholder="Label (optional)" maxLength={60} value={l.label ?? ''} onChange={(e) => setLink(l.key, { label: e.currentTarget.value })} />
                        <input
                          className="ce-in ce-url"
                          type="url"
                          aria-label={`Link ${i + 1} address`}
                          placeholder="https://"
                          value={l.url}
                          onChange={(e) => setLink(l.key, { url: e.currentTarget.value })}
                          onBlur={() => touch(`link:${l.key}`)}
                          aria-invalid={Boolean(err)}
                          aria-describedby={err ? `${ids}-${l.key}-err` : undefined}
                        />
                        <button type="button" className="ce-rm" aria-label={`Remove link ${i + 1}`} onClick={() => set({ links: draft.links.filter((x) => x.key !== l.key) })}>
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                      {err ? (
                        <span className="ce-err" id={`${ids}-${l.key}-err`}>
                          {err}
                        </span>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
              {linksErr ? <span className="ce-err">{linksErr}</span> : null}
              <button type="button" className="ce-file ce-add" disabled={draft.links.length >= LINKS_MAX} onClick={() => set({ links: [...draft.links, { key: newKey(), kind: draft.links.length ? 'website' : 'patreon', url: '' }] })}>
                <Icon name="plus" size={14} /> Add link
              </button>
            </fieldset>
            <button type="submit" hidden />
          </form>
          <div className="ce-savebar">
            <span className="ce-state" role="status" data-error={saveError ? '' : undefined}>
              {stateText}
            </span>
            {upload ? (
              <Button onClick={closeEditor} disabled={busy}>
                Cancel
              </Button>
            ) : (
              <Button onClick={() => (dirty ? setDraft(base) : closeEditor())} disabled={busy}>
                {dirty ? 'Discard' : 'Close'}
              </Button>
            )}
            <button type="button" className="cs-btn" data-pink="" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving' : upload ? 'Save and continue' : 'Save'}
            </button>
          </div>
        </div>
        <section className="ce-preview" aria-label="Preview">
          <span className="ce-lbl">Preview</span>
          <div className="ce-preview-frame">
            <CreatorSheetView page={preview} preview />
          </div>
        </section>
      </div>
    </Frame>
  )
}
