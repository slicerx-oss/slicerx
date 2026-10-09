// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Uploading to the Vault from the app: the current project or a picked file,
// a title, description, tags, license and cover (drawn from the model unless
// the creator picks a picture), and how it printed when the plate was sliced.
// Then Your uploads shows each one moving through the upload, the scan and
// review until it is live or sent back with a note.
import type { FileFormat, Listing, ListingColors, ListingLicense, StoreClient, UploadPrintProfile } from '@slicerx/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, Icon, Seg } from '@slicerx/ui'
import { coverForFile, coverInColors, currentProjectUpload, fileModel, projectHasModels, projectModel, toast, vaultCreatorsInFile, type CoverImage, type UploadModel } from '@slicerx/app'
import { DrawingArt } from './drawing-art'
import { ColorDots, ColorFacts, ColorsEditor } from './colors'
import { draftOf, savedColors, slotColors, type ColorDraft } from './colors-edit'
import { coverFor } from './art'
import { Frame, prepareImage, type PendingImage } from './creator-editor'
import { ago } from './library'
import { CreatorAvatar, count } from './creator-sheet'
import { LIBRARY_KEY, myCreatorQuery, useSession, useStore } from './queries'
import { closeUpload, openEditor, openListing, openUpload, useLibrarySheets } from './sheets'
import { CATEGORIES } from './filter'
import { useWaited } from '../../lib/waited'

const UploadCarry = lazy(() => import('../../ravens/waits').then((m) => ({ default: m.UploadCarry })))

export const LICENSE_LABELS: Record<ListingLicense, string> = {
  cc0: 'CC0, free for anything',
  'cc-by': 'CC BY, credit me',
  'cc-by-sa': 'CC BY-SA, credit me, share alike',
  'cc-by-nc': 'CC BY-NC, credit me, no commercial use',
  'cc-by-nc-sa': 'CC BY-NC-SA, credit me, no commercial use, share alike',
  'cc-by-nd': 'CC BY-ND, credit me, no changes',
  'cc-by-nc-nd': 'CC BY-NC-ND, credit me, no commercial use, no changes',
  custom: 'Custom terms in the description',
}
/** 34 min, 2 h 5 min. */
export function duration(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h ? `${h} h ${m} min` : `${m} min`
}

/** 840 KB, 12.4 MB. */
export function fileSize(n: number): string {
  return n < 1_048_576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1_048_576).toFixed(1)} MB`
}

export const TITLE_MAX = 120
export const DESCRIPTION_MAX = 2000
export const TAGS_MAX = 20

/** Tags as the Vault keeps them: lowercase words joined by hyphens, each once, at most 20. */
export function parseTags(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[,\n]/)) {
    const t = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
    if (t && !out.includes(t)) out.push(t)
  }
  return out.slice(0, TAGS_MAX)
}

/** A picked file's format from its name, or null for anything the Vault does not take. */
export function formatOf(name: string): FileFormat | null {
  const ext = name.toLowerCase().split('.').pop()
  return ext === '3mf' || ext === 'sx3mf' || ext === 'stl' ? ext : null
}

/** A file name the store accepts: lowercase, no folders, plain characters, the format's ending. */
export function uploadName(name: string, format: FileFormat): string {
  const stem = name
    .replace(/\.(sx3mf|3mf|stl)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120)
  return `${stem || 'model'}.${format}`
}

export type UploadStage = 'uploading' | 'scanning' | 'review' | 'live' | 'rejected' | 'archived' | 'removed'

/** Where an upload stands, for Your uploads. */
export function uploadStage(l: Listing): { stage: UploadStage; label: string; note?: string } {
  const v = l.currentVersion
  if (l.status === 'approved') return v && v.reviewStatus === 'pending' ? { stage: 'live', label: 'Live, new version in review' } : { stage: 'live', label: 'Live' }
  if (l.status === 'rejected') return { stage: 'rejected', label: 'Sent back', ...(l.reviewNote ? { note: l.reviewNote } : {}) }
  if (l.status === 'removed') return { stage: 'removed', label: 'Taken down', ...(l.reviewNote ? { note: l.reviewNote } : {}) }
  if (l.status === 'archived') return { stage: 'archived', label: 'Archived' }
  if (!v || v.scanStatus === 'uploading') return { stage: 'uploading', label: 'Uploading' }
  if (v.scanStatus === 'queued' || v.scanStatus === 'scanning') return { stage: 'scanning', label: 'Waiting for the scan' }
  if (v.scanStatus === 'rejected') return { stage: 'rejected', label: 'Failed the scan', ...(l.reviewNote ? { note: l.reviewNote } : {}) }
  return { stage: 'review', label: 'In review' }
}

/** Encodes a drawn cover as WebP (PNG where the browser has no WebP encoder). */
async function encodeCover(img: CoverImage): Promise<PendingImage | null> {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0)
  const blob = (await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.88))) ?? (await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png')))
  if (!blob) return null
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { bytes, contentType: blob.type || 'image/png', preview: URL.createObjectURL(blob) }
}

interface Picked {
  name: string
  bytes: Uint8Array
  format: FileFormat
  vaultCreators: string[]
  printProfile?: UploadPrintProfile
  /** The colors read from the file and its meshes by slot, for drawing the cover in edited colors. */
  model?: UploadModel | null
}

export interface UploadDraft {
  title: string
  description: string
  tags: string
  license: ListingLicense
  /** The model's colors as the creator left them; none for a file without any. */
  colors?: ListingColors | null
}

/** What blocks Submit, by field. */
export function uploadErrors(d: UploadDraft, file: Picked | null, myCreatorId: string | null): Record<string, string> {
  const e: Record<string, string> = {}
  if (!file) e.file = 'Pick a .3mf, .sx3mf or .stl file, or use the current project'
  else if (file.vaultCreators.some((c) => c !== myCreatorId)) e.file = "This holds a design from another creator's Vault page. Upload only your own work."
  const title = d.title.trim()
  if (!title) e.title = 'Give it a title'
  else if (title.length > TITLE_MAX) e.title = `Titles can be at most ${TITLE_MAX} characters`
  if (d.description.length > DESCRIPTION_MAX) e.description = `Descriptions can be at most ${DESCRIPTION_MAX} characters`
  return e
}

/** Sends one upload: the cover, the listing, then the file with its print profile. A listing left without its file is removed again. */
export async function submitUpload(
  store: StoreClient,
  d: UploadDraft,
  file: Picked,
  cover: PendingImage | null,
  includeProfile: boolean,
  step: (s: string) => void = () => undefined,
): Promise<{ ok: true; listing: Listing } | { ok: false; message: string }> {
  let coverUrl: string | undefined
  if (cover) {
    step('Uploading the cover')
    const up = await store.uploadCreatorImage({ kind: 'cover', bytes: cover.bytes, contentType: cover.contentType })
    if (!up.ok) return { ok: false, message: `The cover did not upload: ${up.message}` }
    coverUrl = up.value
  }
  step('Creating the listing')
  const tags = parseTags(d.tags)
  const created = await store.createListing({ title: d.title.trim(), description: d.description.trim(), license: d.license, tags, ...(coverUrl ? { coverUrl } : {}) })
  if (!created.ok) return { ok: false, message: created.message }
  step('Uploading the file')
  const sent = await store.uploadVersion(created.value.id, {
    name: uploadName(file.name, file.format),
    version: '1.0.0',
    bytes: file.bytes,
    format: file.format,
    ...(includeProfile && file.printProfile ? { printProfile: file.printProfile } : {}),
    ...(d.colors ? { colors: d.colors } : {}),
  })
  if (!sent.ok) {
    await store.deleteListing(created.value.id)
    return { ok: false, message: sent.message }
  }
  return { ok: true, listing: created.value }
}

/** The upload flow, when the Vault asked for it. */
export function UploadHost() {
  const { upload } = useLibrarySheets()
  if (!upload) return null
  return upload === 'form' ? <UploadForm /> : <UploadsList />
}

function UploadForm() {
  const store = useStore()
  const client = useQueryClient()
  const ids = useId()
  const { session } = useSession()
  const mine = useQuery(myCreatorQuery(store, Boolean(session)))
  const hasProject = useMemo(() => projectHasModels(), [])
  const [source, setSource] = useState<'project' | 'file'>(hasProject ? 'project' : 'file')
  const [file, setFile] = useState<Picked | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [projectFile, setProjectFile] = useState<Picked | null>(null)
  const [autoCover, setAutoCover] = useState<PendingImage | null>(null)
  const [customCover, setCustomCover] = useState<PendingImage | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [draft, setDraft] = useState<UploadDraft>({ title: '', description: '', tags: '', license: 'cc-by' })
  const [includeProfile, setIncludeProfile] = useState(true)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // An upload that takes a while gets a raven carrying the file.
  const carry = useWaited(busy !== null)
  const [fileError, setFileError] = useState<string | null>(null)
  const urls = useRef<string[]>([])
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), [])

  // Signed in without a creator page: the page comes first.
  useEffect(() => {
    if (session && mine.isSuccess && !mine.isFetching && !mine.data) openEditor('upload')
  }, [session, mine.isSuccess, mine.isFetching, mine.data])

  const keep = (img: PendingImage | null) => {
    if (img) urls.current.push(img.preview)
    return img
  }

  // The current project: its .sx3mf, a cover drawn from it and how it was sliced.
  useEffect(() => {
    if (source !== 'project' || projectFile) return
    let live = true
    setPreparing(true)
    void currentProjectUpload()
      .then(async (p) => {
        if (!live || !p) return
        const model = await projectModel().catch(() => null)
        if (!live) return
        setProjectFile({ name: p.name, bytes: p.bytes, format: 'sx3mf', vaultCreators: p.vaultCreators, model, ...(p.printProfile ? { printProfile: p.printProfile } : {}) })
        setAutoCover(keep(await encodeCover(p.cover)))
        setDraft((d) => (d.title ? d : { ...d, title: p.name.replace(/\.sx3mf$/, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }))
      })
      .finally(() => setPreparing(false))
    return () => {
      live = false
    }
  }, [source, projectFile])

  useEffect(() => setFile(source === 'project' ? projectFile : picked), [source, projectFile, picked])

  // Colors start from the file, and the drawn cover follows the creator's edits.
  const [colors, setColors] = useState<ColorDraft>(() => draftOf(null))
  const [colorsTouched, setColorsTouched] = useState(false)
  useEffect(() => {
    setColors(draftOf(file?.model?.colors?.colors, file?.model?.colors?.slots))
    setColorsTouched(false)
  }, [file])
  useEffect(() => {
    const model = file?.model
    if (!colorsTouched || !model || model.meshes.length === 0) return
    let live = true
    const t = window.setTimeout(() => {
      void coverInColors(model, slotColors(colors)).then(async (img) => {
        const next = img ? keep(await encodeCover(img)) : null
        if (live && next) setAutoCover(next)
      })
    }, 250)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [colors, colorsTouched, file])
  const editColors = (d: ColorDraft) => {
    setColors(d)
    setColorsTouched(true)
  }

  const pickFile = async (f: File | undefined) => {
    if (!f) return
    setFileError(null)
    const format = formatOf(f.name)
    if (!format) {
      setFileError('Pick a .3mf, .sx3mf or .stl file')
      return
    }
    setPreparing(true)
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const [cover, vaultCreators, model] = await Promise.all([coverForFile(f.name, bytes), vaultCreatorsInFile(f.name, bytes), fileModel(f.name, bytes)])
      setPicked({ name: f.name, bytes, format, vaultCreators, model })
      setAutoCover(cover ? keep(await encodeCover(cover)) : null)
      setDraft((d) => (d.title ? d : { ...d, title: f.name.replace(/\.(sx3mf|3mf|stl)$/i, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }))
    } finally {
      setPreparing(false)
    }
  }

  const pickCover = async (f: File | undefined) => {
    if (!f) return
    const r = await prepareImage(f, 'cover')
    if (typeof r === 'string') toast(r, 'error')
    else setCustomCover(keep(r))
  }

  const cover = customCover ?? autoCover
  const errors = uploadErrors(draft, file, mine.data?.id ?? null)
  const shown = (k: string) => (tried ? errors[k] : undefined)
  const tags = parseTags(draft.tags)
  const profile = file?.printProfile

  const submit = async () => {
    setTried(true)
    if (!store || !file || Object.keys(errors).length) return
    setBusy('Starting')
    try {
      const r = await submitUpload(store, { ...draft, colors: savedColors(colors) }, file, cover, includeProfile, setBusy)
      if (!r.ok) {
        toast(r.message, 'error')
        return
      }
      await client.invalidateQueries({ queryKey: LIBRARY_KEY })
      toast(`${r.listing.title} is uploaded and waiting for review`, 'ok')
      openUpload('list')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Frame
      title="Upload a design"
      onClose={closeUpload}
      testId="upload-dialog"
      actions={
        <Button size="sm" data-testid="upload-your-uploads" onClick={() => openUpload('list')}>
          Your uploads
        </Button>
      }
    >
      <div className="ce">
        <div className="ce-col">
          <form
            className="ce-form"
            data-testid="upload-form"
            aria-label="Upload details"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <fieldset className="ce-set">
              <legend>Model</legend>
              {hasProject ? (
                <Seg
                  label="What to upload"
                  size="sm"
                  value={source}
                  onChange={setSource}
                  options={[
                    { value: 'project', label: 'This project', testId: 'upload-source-project' },
                    { value: 'file', label: 'A file', testId: 'upload-source-file' },
                  ]}
                />
              ) : null}
              {source === 'file' ? (
                <div className="ce-ops">
                  <label className="ce-file">
                    <input type="file" accept=".3mf,.sx3mf,.stl" className="sr-only" data-testid="upload-file" aria-label="Pick a model file" onChange={(e) => { void pickFile(e.currentTarget.files?.[0]); e.currentTarget.value = '' }} />
                    <Icon name="upload" size={14} />
                    <span aria-hidden="true">{picked ? 'Pick another file' : 'Pick a file'}</span>
                  </label>
                  {picked ? (
                    <span className="up-file sx-mono">
                      {picked.name} <span className="ce-hint">{fileSize(picked.bytes.length)}</span>
                    </span>
                  ) : (
                    <span className="ce-hint">.3mf, .sx3mf or .stl up to 100 MB</span>
                  )}
                </div>
              ) : (
                <span className="ce-hint" data-testid="upload-project-file">{preparing ? 'Packing the project as .sx3mf' : projectFile ? `Every plate as ${projectFile.name}, ${fileSize(projectFile.bytes.length)}` : 'The plates are empty'}</span>
              )}
              {fileError ? <span className="ce-err">{fileError}</span> : null}
              {shown('file') ?? (file && errors.file) ? (
                <span className="ce-err" role="alert">
                  {errors.file}
                </span>
              ) : null}
            </fieldset>

            <fieldset className="ce-set">
              <legend>About the design</legend>
              <div className="ce-field">
                <label htmlFor={`${ids}-title`}>Title</label>
                <input className="ce-in" id={`${ids}-title`} data-testid="upload-title" value={draft.title} maxLength={TITLE_MAX} onChange={(e) => setDraft({ ...draft, title: e.currentTarget.value })} aria-invalid={Boolean(shown('title'))} />
                {shown('title') ? <span className="ce-err">{shown('title')}</span> : null}
              </div>
              <div className="ce-field">
                <label htmlFor={`${ids}-desc`}>Description</label>
                <textarea className="ce-in ce-ta" id={`${ids}-desc`} data-testid="upload-description" value={draft.description} maxLength={DESCRIPTION_MAX} rows={5} placeholder="What it is, how it prints, anything to know before printing." onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })} />
                <span className="ce-count">
                  {draft.description.length} of {DESCRIPTION_MAX}
                </span>
              </div>
              <div className="ce-field">
                <label htmlFor={`${ids}-tags`}>
                  Tags <span className="ce-hint">comma separated, up to {TAGS_MAX}</span>
                </label>
                <input className="ce-in" id={`${ids}-tags`} data-testid="upload-tags" value={draft.tags} placeholder="functional, desk, print-in-place" onChange={(e) => setDraft({ ...draft, tags: e.currentTarget.value })} />
                <div className="up-tags">
                  {CATEGORIES.filter((c) => c !== 'all' && !tags.includes(c)).map((c) => (
                    <button key={c} type="button" className="lib-chip" data-testid={`upload-tag-${c}`} onClick={() => setDraft({ ...draft, tags: [...tags, c].join(', ') })}>
                      <Icon name="plus" size={12} /> {c}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ce-field">
                <label htmlFor={`${ids}-license`}>License</label>
                <select className="ce-in" id={`${ids}-license`} data-testid="upload-license" value={draft.license} onChange={(e) => setDraft({ ...draft, license: e.currentTarget.value as ListingLicense })}>
                  {(Object.keys(LICENSE_LABELS) as ListingLicense[]).map((k) => (
                    <option key={k} value={k}>
                      {LICENSE_LABELS[k]}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>

            <fieldset className="ce-set">
              <legend>Colors</legend>
              <span className="ce-hint">{file?.model?.colors ? 'Read from the file. Name them, put them in order and mark the parts that need the AMS.' : 'Add the colors it prints in, so makers know what to load.'}</span>
              <ColorsEditor draft={colors} onChange={editColors} />
            </fieldset>

            <fieldset className="ce-set">
              <legend>Cover</legend>
              <div className="up-cover">
                <span className="cs-art" data-testid="upload-cover" data-source={customCover ? 'picture' : autoCover ? 'render' : 'none'}>
                  {cover ? <img src={cover.preview} alt="Cover" /> : <DrawingArt seed={draft.title || 'cover'} />}
                </span>
                <div className="ce-logo-b">
                  <div className="ce-ops">
                    <label className="ce-file">
                      <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="upload-cover-file" aria-label="Pick a cover picture" onChange={(e) => { void pickCover(e.currentTarget.files?.[0]); e.currentTarget.value = '' }} />
                      <span aria-hidden="true">Use a picture</span>
                    </label>
                    {customCover && autoCover ? (
                      <button type="button" className="ce-file" data-testid="upload-cover-render" onClick={() => setCustomCover(null)}>
                        Use the render
                      </button>
                    ) : null}
                  </div>
                  <span className="ce-hint">{customCover ? 'Your picture, 4 by 3 works best.' : autoCover ? 'Drawn from the model. Use a photo of the print if you have one.' : 'PNG, JPEG or WebP up to 5 MB, 4 by 3 works best.'}</span>
                </div>
              </div>
            </fieldset>

            {profile ? (
              <fieldset className="ce-set">
                <legend>How it printed</legend>
                <label className="up-check">
                  <input type="checkbox" data-testid="upload-include-profile" checked={includeProfile} onChange={(e) => setIncludeProfile(e.currentTarget.checked)} />
                  <span>
                    Show {profile.printerModel}, {profile.process}, {profile.filament}
                    {profile.timeS ? `, ${duration(profile.timeS)}` : ''}
                    {profile.grams ? `, ${Math.round(profile.grams)} g` : ''} on the listing
                  </span>
                </label>
              </fieldset>
            ) : null}
            <p className="ce-hint">Uploads are checked for malware and reviewed before they go live. Your design leaves the Vault only as a sealed .sx3mf.</p>
            <button type="submit" hidden />
          </form>
          <div className="ce-savebar">
            <span className="ce-state" role="status" data-testid="upload-state">
              {carry ? <Suspense fallback={null}><UploadCarry /></Suspense> : null}
              {busy ?? (preparing ? 'Preparing' : file ? 'Ready to send' : 'Pick what to upload')}
            </span>
            <Button onClick={closeUpload} disabled={busy !== null} data-testid="upload-cancel">
              Cancel
            </Button>
            <Button variant="primary" icon="cloud-upload" data-testid="upload-publish" onClick={() => void submit()} disabled={busy !== null || preparing}>
              Submit for review
            </Button>
          </div>
        </div>
        <section className="ce-preview" aria-label="Preview">
          <span className="ce-lbl">How it shows in the Vault</span>
          <div className="up-preview">
            <div className="lib-mini">
              <div className="lib-mini-art">
                <span className="lib-thumb" aria-hidden="true">
                  {cover ? <img src={cover.preview} alt="" /> : <DrawingArt seed={draft.title || 'cover'} />}
                </span>
                {colors.colors.colors.length ? (
                  <span className="lib-dots" aria-hidden="true">
                    <ColorDots colors={colors.colors} size="sm" max={5} focusable={false} />
                  </span>
                ) : null}
              </div>
              <h3 className="lib-mini-t">{draft.title.trim() || 'Your design'}</h3>
              <div className="lib-mini-meta">
                <span className="lib-who" data-static="">
                  <CreatorAvatar name={mine.data?.displayName ?? 'You'} url={mine.data?.logoUrl} size="sm" />
                  <span>{mine.data?.displayName ?? 'You'}</span>
                </span>
              </div>
            </div>
            {colors.colors.colors.length ? <ColorFacts colors={colors.colors} /> : null}
            <div className="cs-roles">
              <span className="cs-role" data-staff="">
                {draft.license.toUpperCase()}
              </span>
              {tags.slice(0, 6).map((t) => (
                <span key={t} className="cs-role">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>
    </Frame>
  )
}

/** The colors of an uploaded design, edited after the upload. Saved on its newest version without a new review. */
function ColorsFrame({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const store = useStore()
  const client = useQueryClient()
  const version = listing.currentVersion
  const [draft, setDraft] = useState<ColorDraft>(() => draftOf(version?.colors))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cover = coverFor(listing)
  const save = async () => {
    if (!store || !version) return
    setBusy(true)
    setError(null)
    try {
      const r = await store.setVersionColors(version.id, savedColors(draft))
      if (!r.ok) {
        setError(r.message)
        return
      }
      await client.invalidateQueries({ queryKey: LIBRARY_KEY })
      toast(`Colors saved for ${listing.title}`, 'ok')
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Frame title={`Colors of ${listing.title}`} onClose={onClose}>
      <div className="ce">
        <div className="ce-col">
          <form
            className="ce-form"
            aria-label="Colors"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <fieldset className="ce-set">
              <legend>Colors</legend>
              <span className="ce-hint">Name them, put them in order and mark the parts that need the AMS. Changes show on the listing at once.</span>
              <ColorsEditor draft={draft} onChange={setDraft} />
            </fieldset>
            <button type="submit" hidden />
          </form>
          <div className="ce-savebar">
            <span className="ce-state" role="status" data-error={error ? '' : undefined}>
              {error ?? (busy ? 'Saving' : `Version ${version?.version ?? ''}`)}
            </span>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" icon="save" onClick={() => void save()} disabled={busy || !version}>
              Save colors
            </Button>
          </div>
        </div>
        <section className="ce-preview" aria-label="Preview">
          <span className="ce-lbl">How it shows in the Vault</span>
          <div className="up-preview">
            <div className="lib-mini">
              <div className="lib-mini-art">
                <span className="lib-thumb" aria-hidden="true">
                  {cover ? <img src={cover} alt="" /> : <DrawingArt seed={listing.slug} />}
                </span>
                {draft.colors.colors.length ? (
                  <span className="lib-dots" aria-hidden="true">
                    <ColorDots colors={draft.colors} size="sm" max={5} focusable={false} />
                  </span>
                ) : null}
              </div>
              <h3 className="lib-mini-t">{listing.title}</h3>
            </div>
            {draft.colors.colors.length ? <ColorFacts colors={draft.colors} /> : <p className="ce-hint">No colors show on the listing.</p>}
          </div>
        </section>
      </div>
    </Frame>
  )
}

function UploadsList() {
  const store = useStore()
  const { session } = useSession()
  const [editing, setEditing] = useState<Listing | null>(null)
  const q = useQuery({
    queryKey: ['library', 'my-listings', session?.userId],
    queryFn: async () => (store && session ? store.myListings() : []),
    enabled: Boolean(store && session),
    // Poll while something is still on its way.
    refetchInterval: (query) => ((query.state.data ?? []).some((l) => ['uploading', 'scanning', 'review'].includes(uploadStage(l).stage)) ? 5000 : false),
  })
  const items = [...(q.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (editing) return <ColorsFrame listing={editing} onClose={() => setEditing(null)} />
  return (
    <Frame
      title="Your uploads"
      onClose={closeUpload}
      testId="uploads-list"
      actions={
        <Button size="sm" variant="primary" icon="cloud-upload" data-testid="uploads-new" onClick={() => openUpload('form')}>
          Upload a design
        </Button>
      }
    >
      <div className="up-list-wrap">
        {!session ? <p className="app-empty">Sign in to upload designs.</p> : null}
        {q.isPending && session ? <div className="ce-loading skeleton" aria-busy="true" /> : null}
        {q.isSuccess && items.length === 0 ? <p className="app-empty">Nothing uploaded yet. Upload a design to share it in the Vault.</p> : null}
        {items.length ? (
          <ul className="up-list" aria-label="Your uploads">
            {items.map((l) => {
              const st = uploadStage(l)
              const cover = coverFor(l)
              return (
                <li key={l.id} className="up-row" data-testid="uploads-row" data-listing={l.id}>
                  <span className="cs-art">{cover ? <img src={cover} alt="" /> : <DrawingArt seed={l.slug} />}</span>
                  <div className="min0">
                    <b className="up-title">{l.title}</b>
                    <span className="ce-hint">
                      {l.currentVersion ? `Version ${l.currentVersion.version}, ` : ''}
                      {ago(l.createdAt)}
                      {l.stats && st.stage === 'live' ? `, ${count(l.stats.downloads)} downloads` : ''}
                    </span>
                    {st.note ? <p className="up-note">{st.note}</p> : null}
                  </div>
                  <span className="up-stage" data-testid="uploads-stage" data-stage={st.stage}>
                    {st.label}
                  </span>
                  <div className="up-acts">
                    {l.currentVersion && st.stage !== 'removed' ? (
                      <Button size="sm" variant="ghost" aria-label={`Colors of ${l.title}`} onClick={() => setEditing(l)}>
                        {l.currentVersion.colors ? <ColorDots colors={l.currentVersion.colors} size="sm" max={3} focusable={false} /> : null}
                        Colors
                      </Button>
                    ) : null}
                    {st.stage === 'live' ? (
                      <Button size="sm" variant="ghost" data-testid="uploads-view" onClick={() => { closeUpload(); openListing(l.id) }}>
                        View
                      </Button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : null}
        <p className="ce-hint up-foot">
          New uploads wait for a malware scan, then a review. Most are looked at within a day.
        </p>
      </div>
    </Frame>
  )
}
