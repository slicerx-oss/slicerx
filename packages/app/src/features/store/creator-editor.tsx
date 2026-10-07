// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creator page editor: banner, logo, name, handle, bio, pinned design and
// links, with the creator sheet beside it as a live preview. Opens from the
// account settings, Edit page on your own sheet, and Upload when you have no
// page yet.
import type { Creator, CreatorImageKind, CreatorLinkInput, CreatorLinkKind, CreatorPage, Listing, Session, StoreClient } from '@slicerx/contracts'
import { validateCreatorLink, validateHandle, MAX_CREATOR_LINKS } from '@slicerx/store/validate'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, Dialog, Field, Icon, Input, Select, Textarea } from '@slicerx/ui'
import { toast, useEdition, useHost } from '@slicerx/app'
import { CreatorSheetView } from './creator-sheet'
import { LINK_KIND_INFO, LINK_KINDS } from './links'
import { creatorPageQuery, LIBRARY_KEY, myCreatorQuery, useSession, useStore } from './queries'
import { dashboardUrl, openExternal } from './routes'
import { closeEditor, openCreator, useLibrarySheets } from './sheets'

/** Longest bio the editor takes. The database allows more; a sheet reads best short. */
export const BIO_MAX = 1000
export const NAME_MAX = 80
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Largest stored size: banners 1800 by 600, logos 512 square. Bigger pictures are scaled down before upload. */
const IMAGE_BOX: Record<CreatorImageKind, [number, number]> = { banner: [1800, 600], logo: [512, 512] }

interface LinkDraft extends CreatorLinkInput {
  key: string
}

/** An image the creator picked: kept as bytes until Save, shown from an object URL meanwhile. */
interface PendingImage {
  bytes: Uint8Array
  contentType: string
  preview: string
}

/** An image field: unchanged, replaced by a new pick, or removed. */
type ImageState = { kind: 'keep' } | { kind: 'new'; image: PendingImage } | { kind: 'remove' }

export interface EditorDraft {
  handle: string
  displayName: string
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
    bio: c?.bio ?? '',
    pinnedId: page?.featured[0]?.id ?? null,
    links: (page?.links ?? []).map((l) => ({ key: newKey(), kind: l.kind, url: l.url, ...(l.label ? { label: l.label } : {}) })),
    banner: { kind: 'keep' },
    logo: { kind: 'keep' },
  }
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
  if (d.bio.length > BIO_MAX) e.bio = `Bios can be at most ${BIO_MAX} characters`
  if (d.links.length > MAX_CREATOR_LINKS) e.links = `A creator page has at most ${MAX_CREATOR_LINKS} links`
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
  const { bannerUrl: _b, logoUrl: _l, bio: _bio, ...rest } = base
  const approved = page?.listings ?? own.filter((l) => l.status === 'approved')
  const pinned = approved.find((l) => l.id === d.pinnedId)
  return {
    creator: {
      ...rest,
      handle: d.handle,
      displayName: d.displayName.trim(),
      ...(d.bio.trim() ? { bio: d.bio.trim() } : {}),
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
async function prepareImage(file: File, kind: CreatorImageKind): Promise<PendingImage | string> {
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

/** Saves the draft in order: the page itself, then images, links and the pinned design. Stops at the first failure. */
export async function saveDraft(store: StoreClient, d: EditorDraft, page: CreatorPage | null): Promise<{ ok: true; creator: Creator } | { ok: false; message: string }> {
  const text = { handle: page?.creator.handle ?? d.handle, displayName: d.displayName.trim(), bio: d.bio.trim() || null }
  const first = await store.saveCreator(text)
  if (!first.ok) return { ok: false, message: first.message }
  let creator = first.value
  const urls: { logoUrl?: string | null; bannerUrl?: string | null } = {}
  for (const kind of ['banner', 'logo'] as const) {
    const s = kind === 'banner' ? d.banner : d.logo
    const key = kind === 'banner' ? 'bannerUrl' : 'logoUrl'
    if (s.kind === 'remove') urls[key] = null
    if (s.kind === 'new') {
      const up = await store.uploadCreatorImage({ kind, bytes: s.image.bytes, contentType: s.image.contentType })
      if (!up.ok) return { ok: false, message: `The ${kind} did not upload: ${up.message}` }
      urls[key] = up.value
    }
  }
  if (Object.keys(urls).length) {
    const again = await store.saveCreator({ ...text, ...urls })
    if (!again.ok) return { ok: false, message: again.message }
    creator = again.value
  }
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
}

/** The editor, when the Library asked for it. */
export function CreatorEditorHost() {
  const { editor } = useLibrarySheets()
  return editor ? <CreatorEditor why={editor} /> : null
}

function CreatorEditor({ why }: { why: 'edit' | 'upload' }) {
  const store = useStore()
  const { session, ready: sessionReady } = useSession()
  const mine = useQuery(myCreatorQuery(store, Boolean(session)))
  const page = useQuery(creatorPageQuery(store, mine.data?.handle ?? null))
  const own = useQuery({ queryKey: ['library', 'my-listings', session?.userId], queryFn: async () => (store && session ? store.myListings() : []), enabled: Boolean(store && session) })
  const ready = sessionReady && (!session || (mine.isSuccess && (!mine.data || page.isSuccess)))
  const title = mine.data ? 'Creator page' : 'Set up your creator page'
  if (sessionReady && !session) {
    return (
      <Dialog open onClose={closeEditor} title={title} footer={<Button onClick={closeEditor}>Close</Button>}>
        <p>Sign in to make a creator page.</p>
      </Dialog>
    )
  }
  if (!ready || !session) {
    return (
      <Dialog open onClose={closeEditor} title="Creator page" className="ce-dialog" size="lg">
        <div className="ce-loading skeleton" aria-busy="true" />
      </Dialog>
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
  const [draft, setDraft] = useState(() => initialDraft(page, session))
  const [touched, setTouched] = useState<Set<string>>(() => new Set())
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const handleFixed = Boolean(page)
  const errors = useMemo(() => draftErrors(draft, handleFixed), [draft, handleFixed])
  const shown = (k: string) => (tried || touched.has(k) ? errors[k] : undefined)
  const touch = (k: string) => setTouched((t) => new Set(t).add(k))
  const preview = useMemo(() => previewPage(draft, page, own, session), [draft, page, own, session])
  const approved = page?.listings ?? own.filter((l) => l.status === 'approved')
  const upload = why === 'upload'

  // Object URLs for picked images go when the editor closes.
  const urls = useRef<string[]>([])
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), [])

  const set = (patch: Partial<EditorDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const setLink = (key: string, patch: Partial<LinkDraft>) => setDraft((d) => ({ ...d, links: d.links.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
  const moveLink = (key: string, by: -1 | 1) =>
    setDraft((d) => {
      const i = d.links.findIndex((l) => l.key === key)
      const j = i + by
      if (i < 0 || j < 0 || j >= d.links.length) return d
      const links = [...d.links]
      const [l] = links.splice(i, 1)
      if (l) links.splice(j, 0, l)
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

  const continueToUpload = () => void openExternal(host, dashboardUrl(edition))

  const save = async () => {
    setTried(true)
    if (!store || Object.keys(errors).length) return
    setBusy(true)
    try {
      const r = await saveDraft(store, draft, page)
      if (!r.ok) {
        toast(r.message, 'error')
        return
      }
      await client.invalidateQueries({ queryKey: LIBRARY_KEY })
      void client.invalidateQueries({ queryKey: ['session'] })
      toast(page ? 'Creator page saved' : 'Creator page created', 'ok')
      closeEditor()
      if (upload) continueToUpload()
      else openCreator(r.creator.handle)
    } finally {
      setBusy(false)
    }
  }

  const hasImage = (s: ImageState, current: string | undefined) => s.kind === 'new' || (s.kind === 'keep' && Boolean(current))
  const imageRow = (kind: CreatorImageKind, label: string, hint: string) => {
    const state = kind === 'banner' ? draft.banner : draft.logo
    const current = kind === 'banner' ? page?.creator.bannerUrl : page?.creator.logoUrl
    const id = `${ids}-${kind}`
    return (
      <div className="ce-image">
        <span className="ce-label" id={`${id}-l`}>
          {label}
        </span>
        <div className="ce-image-row">
          <label className="ce-file">
            <input id={id} type="file" accept={IMAGE_TYPES.join(',')} className="sr-only" aria-describedby={`${id}-h`} onChange={(e) => { void pick(kind, e.currentTarget.files?.[0]); e.currentTarget.value = '' }} />
            <Icon name="upload" size={16} />
            <span>{hasImage(state, current) ? 'Change' : 'Upload'}</span>
          </label>
          {hasImage(state, current) ? (
            <Button size="sm" variant="ghost" icon="delete" onClick={() => set({ [kind]: { kind: 'remove' } } as Partial<EditorDraft>)}>
              Remove
            </Button>
          ) : null}
          <span className="sx-small dim" id={`${id}-h`}>
            {hint}
          </span>
        </div>
      </div>
    )
  }

  const footer = (
    <>
      {upload ? (
        <Button variant="ghost" onClick={() => { closeEditor(); continueToUpload() }} disabled={busy}>
          Skip for now
        </Button>
      ) : (
        <Button variant="ghost" onClick={closeEditor} disabled={busy}>
          Cancel
        </Button>
      )}
      <Button variant="primary" icon="check" onClick={() => void save()} disabled={busy}>
        {busy ? 'Saving' : upload ? 'Save and upload' : page ? 'Save page' : 'Create page'}
      </Button>
    </>
  )

  return (
    <Dialog open onClose={closeEditor} title={page ? 'Creator page' : 'Set up your creator page'} className="ce-dialog" size="lg" footer={footer} splitFooter>
      {upload && !page ? <p className="ce-intro">Your uploads show on your creator page. Add a name and a few details now, or skip and do it later from your account.</p> : null}
      <div className="ce">
        <form
          className="ce-form"
          aria-label="Creator page details"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <fieldset className="ce-set">
            <legend>Images</legend>
            {imageRow('banner', 'Banner', 'Wide image, 3 by 1 works best. PNG, JPEG or WebP up to 5 MB.')}
            {imageRow('logo', 'Logo', 'Square, at least 256 px.')}
            {imageError ? (
              <p className="ce-err" role="alert">
                {imageError}
              </p>
            ) : null}
          </fieldset>
          <fieldset className="ce-set">
            <legend>About you</legend>
            <Field htmlFor={`${ids}-name`} label="Display name" aside={`${draft.displayName.trim().length}/${NAME_MAX}`} error={shown('displayName')}>
              <Input id={`${ids}-name`} value={draft.displayName} maxLength={NAME_MAX + 20} onChange={(e) => set({ displayName: e.currentTarget.value })} onBlur={() => touch('displayName')} aria-invalid={Boolean(shown('displayName'))} />
            </Field>
            <Field
              htmlFor={`${ids}-handle`}
              label="Handle"
              hint={handleFixed ? 'Handles stay the same once your page exists, so links to it keep working.' : '3 to 32 lowercase letters, digits or hyphens. It cannot be changed later.'}
              error={shown('handle')}
            >
              <Input id={`${ids}-handle`} mono icon="creator" placeholder="your-name" value={draft.handle} readOnly={handleFixed} aria-readonly={handleFixed} onChange={(e) => set({ handle: e.currentTarget.value.toLowerCase() })} onBlur={() => touch('handle')} aria-invalid={Boolean(shown('handle'))} />
            </Field>
            <Field htmlFor={`${ids}-bio`} label="Bio" aside={`${draft.bio.length}/${BIO_MAX}`} hint="Plain text. Line breaks are kept." error={shown('bio')}>
              <Textarea id={`${ids}-bio`} rows={5} value={draft.bio} onChange={(e) => set({ bio: e.currentTarget.value })} onBlur={() => touch('bio')} aria-invalid={Boolean(shown('bio'))} />
            </Field>
          </fieldset>
          <fieldset className="ce-set">
            <legend>Pinned design</legend>
            <Field htmlFor={`${ids}-pin`} label="Shown first on your page" hint={approved.length ? undefined : 'Your designs can be pinned once they are approved.'}>
              <Select id={`${ids}-pin`} value={draft.pinnedId ?? ''} disabled={approved.length === 0} onChange={(e) => set({ pinnedId: e.currentTarget.value || null })}>
                <option value="">None</option>
                {approved.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>
          <fieldset className="ce-set">
            <legend>Links</legend>
            {draft.links.length === 0 ? <p className="sx-small dim">Patreon, MakerWorld, your shop or socials. Up to {MAX_CREATOR_LINKS}.</p> : null}
            <ol className="ce-links">
              {draft.links.map((l, i) => {
                const err = shown(`link:${l.key}`)
                return (
                  <li key={l.key} className="ce-link">
                    <div className="ce-link-row">
                      <Select id={`${ids}-${l.key}-kind`} size="sm" aria-label={`Link ${i + 1} type`} value={l.kind} onChange={(e) => setLink(l.key, { kind: e.currentTarget.value as CreatorLinkKind })}>
                        {LINK_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {LINK_KIND_INFO[k].label}
                          </option>
                        ))}
                      </Select>
                      <Input id={`${ids}-${l.key}-label`} size="sm" aria-label={`Link ${i + 1} label`} placeholder="Label (optional)" maxLength={60} value={l.label ?? ''} onChange={(e) => setLink(l.key, { label: e.currentTarget.value })} />
                      <div className="ce-link-tools">
                        <Button size="sm" variant="ghost" icon="arrow-up" aria-label={`Move link ${i + 1} up`} disabled={i === 0} onClick={() => moveLink(l.key, -1)} />
                        <Button size="sm" variant="ghost" icon="arrow-down" aria-label={`Move link ${i + 1} down`} disabled={i === draft.links.length - 1} onClick={() => moveLink(l.key, 1)} />
                        <Button size="sm" variant="ghost" icon="delete" aria-label={`Remove link ${i + 1}`} onClick={() => set({ links: draft.links.filter((x) => x.key !== l.key) })} />
                      </div>
                    </div>
                    <Input
                      id={`${ids}-${l.key}-url`}
                      size="sm"
                      mono
                      type="url"
                      aria-label={`Link ${i + 1} address`}
                      placeholder="https://"
                      value={l.url}
                      onChange={(e) => setLink(l.key, { url: e.currentTarget.value })}
                      onBlur={() => touch(`link:${l.key}`)}
                      aria-invalid={Boolean(err)}
                      aria-describedby={err ? `${ids}-${l.key}-err` : undefined}
                    />
                    {err ? (
                      <span className="ce-err" id={`${ids}-${l.key}-err`}>
                        {err}
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ol>
            <Button size="sm" icon="plus" disabled={draft.links.length >= MAX_CREATOR_LINKS} onClick={() => set({ links: [...draft.links, { key: newKey(), kind: draft.links.length ? 'website' : 'patreon', url: '' }] })}>
              Add link
            </Button>
          </fieldset>
          <button type="submit" hidden />
        </form>
        <section className="ce-preview" aria-label="Preview">
          <span className="ce-label">Preview</span>
          <div className="ce-preview-frame">
            <CreatorSheetView page={preview} own preview />
          </div>
        </section>
      </div>
    </Dialog>
  )
}
