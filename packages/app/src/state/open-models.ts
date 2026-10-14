// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening models: files, bytes and the built-in examples onto the plate. Loaded with the first open, not with the
// app; state/actions.ts keeps the names everyone calls.
import type { FileRef, Host } from '@slicerx/contracts'
import type { DecodedModel } from '@slicerx/embed/mesh'
import { brandAccent } from '../edition'
import { withAutoSpools } from '../filament/pick'
import { DEFAULT_MODEL, demoModel } from '../lib/demo-models'
import { markOpenEnded, markOpenStage, markOpenStarted } from '../lib/open-mark'
import { clearProject } from '../project/new'
import { beginOpen, confirmDiscard, markClean, OpenSuperseded, type OpenScope } from '../project/unsaved'
import { isGcodeName, openGcodeRef } from '../workspaces/preview/gcode-file'
import { identity, uid } from './actions'
import { get, markStale, set, toast, type ModelSource, type PlateEntry } from './store'

/** Places the object at the bed center; models are stored centered on X and Y. */
function centered(bedW: number, bedD: number): number[] {
  const t = identity()
  t[12] = bedW / 2
  t[13] = bedD / 2
  return t
}

// Designs opened this session (a file, a Vault design, an example picked by hand), and whether the example plate
// was put out at the start.
let opened = 0
let seeded = false

async function addDecoded(host: Host, model: DecodedModel, opts: { replace: boolean; thumb?: string; keep?: () => boolean; scope?: OpenScope | undefined; autoSpool?: boolean }): Promise<PlateEntry | null> {
  const handle = await host.slicer.loadParts(model.name, model.parts)
  if (opts.keep && !opts.keep()) return null
  const { bed } = get()
  const made: PlateEntry = {
    id: uid('obj'),
    name: model.name,
    handle,
    parts: model.parts,
    colors: model.colors,
    transform: centered(bed.widthMm, bed.depthMm),
    ...(opts.thumb ? { thumb: opts.thumb } : {}),
  }
  // a plain STL has no filament of its own: it starts on the auto-picked spool
  const entry = opts.autoSpool ? withAutoSpools([made], {})[0]! : made
  const add = () => set((s) => ({ plate: opts.replace ? [entry] : [...s.plate, entry], selection: entry.id }))
  if (opts.scope) opts.scope.run(add)
  else add()
  markStale()
  return entry
}

/** Puts one of the built-in example models on the plate. */
export async function loadDemoModel(host: Host, slug: string, opts: { replace?: boolean; keep?: () => boolean } = {}): Promise<void> {
  const demo = demoModel(slug)
  if (!demo) {
    toast(`No example model called ${slug}`, 'error')
    return
  }
  // Picked by hand, it is an opened design; the start of session example passes `keep`.
  if (!opts.keep) opened++
  set({ plateLoading: true })
  try {
    const { parts, colors } = await demo.build()
    const model: DecodedModel = { name: demo.name, bboxMm: [0, 0, 0], triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), parts, colors, offset: [0, 0, 0] }
    const added = await addDecoded(host, model, { replace: opts.replace ?? true, ...(opts.keep ? { keep: opts.keep } : {}) })
    if (added && (opts.replace ?? true)) {
      set({ slice: { status: 'idle' }, preview: null, projectFile: null })
      markClean()
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not load the model', 'error')
  } finally {
    set({ plateLoading: false, sliceDuringOpen: false })
  }
}

/** The example plate. */
export function loadDefaultPlate(host: Host): Promise<void> {
  return loadDemoModel(host, DEFAULT_MODEL, { replace: true })
}

/**
 * The example a fresh session starts with: once, never after a design was opened, and dropped if a design opens while
 * it loads. A plate the person emptied stays empty.
 */
export function seedExamplePlate(host: Host): Promise<void> {
  if (seeded || opened > 0) return Promise.resolve()
  seeded = true
  return loadDemoModel(host, DEFAULT_MODEL, { replace: true, keep: () => opened === 0 })
}

/** A new project for an opened design: asks about unsaved work first (Save, Discard, Cancel). False when canceled. */
async function startFresh(): Promise<boolean> {
  opened++
  if (!(await confirmDiscard('open another design'))) return false
  // loading first, so the 3D view holds the old scene through the clear until the new model draws
  set({ plateLoading: true })
  clearProject()
  return true
}

/** Returns true when it already told the person what it did (a toast of its own). */
async function addBytes(host: Host, name: string, data: ArrayBuffer, scope?: OpenScope): Promise<boolean> {
  if (/\.(stl|obj|amf|step|stp)$/i.test(name)) {
    // Every mesh goes through the engine: repaired, unit detected, loose bodies split. STEP files are
    // meshed first in a worker of their own.
    const { addAutoImport } = await import('./import-auto')
    try {
      await addAutoImport(host, name, data, undefined, undefined, scope)
    } catch (e) {
      // Without the engine (a host that has none) an STL still opens, unrepaired.
      if (!/\.stl$/i.test(name)) throw e
      const { decodeStl } = await import('@slicerx/embed/mesh')
      try {
        await addDecoded(host, decodeStl(data, name), { replace: false, scope, autoSpool: true })
      } catch {
        throw e
      }
      return false
    }
    return true
  } else if (/\.json$/i.test(name)) {
    const { decodeQuantized } = await import('@slicerx/embed/mesh')
    const json: unknown = JSON.parse(new TextDecoder().decode(data))
    await addDecoded(host, decodeQuantized(json), { replace: false, scope })
  } else {
    // A project with objects, parts and volumes opens as such.
    // The project reader loads with the first project, not with the app.
    const opened = await (await import('./open-project')).addProject(host, data, name, scope)
    if (opened) return opened === 'told'
    // 3MF geometry for the viewport arrives with the core's mesh export; slice it meanwhile.
    const handle = await host.slicer.loadModel(data, name)
    // A Vault design stays one when the engine opens it.
    const source = await (await import('../export/import3mf')).vaultSourceOf(new Uint8Array(data))
    const { bed } = get()
    const add = () =>
      set((s) => ({
        plate: [...s.plate, { id: uid('obj'), name: handle.name, handle, parts: [], colors: handle.parts.map((p) => p.color ?? brandAccent()), transform: centered(bed.widthMm, bed.depthMm), ...(source ? { source } : {}) }],
      }))
    if (scope) scope.run(add)
    else add()
    markStale()
  }
  return false
}

/**
 * Opens model bytes that came from somewhere other than a file dialog (a download, a feature). `fresh` (a Vault design,
 * a recent project) starts a new project; otherwise they go onto the plate as it is.
 */
export async function openModelBytes(host: Host, name: string, data: ArrayBuffer, source?: ModelSource, opts: { fresh?: boolean } = {}): Promise<void> {
  if (opts.fresh && !(await startFresh())) return
  // A new project ends clean, unless the person edited it while it opened.
  const scope = opts.fresh ? beginOpen() : undefined
  markOpenStarted(name)
  markOpenStage('read')
  set({ plateLoading: true })
  try {
    const before = new Set(get().plate.map((p) => p.id))
    const told = await addBytes(host, name, data, scope)
    // A model from the library keeps its model and creator ids for the sx3mf it is saved in.
    if (source && (source.modelId || source.creatorId)) {
      const tag = () => set((s) => ({ plate: s.plate.map((p) => (before.has(p.id) ? p : { ...p, source })) }))
      if (scope) scope.run(tag)
      else tag()
    }
    scope?.run(() => undefined)
    scope?.finish()
    if (!told) toast(`Added ${name}`)
  } catch (e) {
    scope?.finish(false)
    // A newer open took over: it says what it opened.
    if (e instanceof OpenSuperseded) return
    toast(e instanceof Error ? e.message : `Could not open ${name}`, 'error')
  } finally {
    if (!scope?.superseded) {
      set({ plateLoading: false, sliceDuringOpen: false })
      markOpenEnded()
    }
  }
}

/** `fresh`: the files start a new project (Open); otherwise they go onto the plate as it is (Add model, a drop). */
export async function addFileRefs(host: Host, refs: FileRef[], opts: { fresh?: boolean } = {}): Promise<void> {
  // A G-code file opens in Preview to view, not on the plate.
  const gcode = refs.filter((r) => isGcodeName(r.name))
  if (gcode.length) {
    await openGcodeRef(host, gcode[gcode.length - 1] as FileRef)
    refs = refs.filter((r) => !isGcodeName(r.name))
  }
  if (refs.length === 0) return
  // A locked project is unlocked first, so a refusal (offline, another account) changes nothing on the plate.
  const unlocked = refs.some((r) => /\.sxlock$/i.test(r.name)) ? await (await import('../export/locked')).unlockRefs(host, refs) : new Map<FileRef, { name: string; data: ArrayBuffer }>()
  if (!unlocked) return
  const project = refs.some((r) => /\.(sx3mf|3mf|sxlock)$/i.test(r.name))
  if (opts.fresh && !(await startFresh())) return
  const wasEmpty = get().plate.length === 0 && get().plates.every((p) => p.objects.length === 0)
  // A new project, or a project onto an empty plate, ends clean, unless the person edited it while it opened.
  const scope = opts.fresh || (project && wasEmpty) ? beginOpen() : undefined
  markOpenStarted(refs.length === 1 ? (refs[0]?.name ?? '') : `${refs.length} files`)
  set({ plateLoading: true })
  try {
    let told = false
    for (const ref of refs) {
      const open = unlocked.get(ref)
      const name = open?.name ?? ref.name
      const data = open?.data ?? (await host.files.read(ref))
      markOpenStage('read')
      // A copy is taken first: a worker may take the original. A locked project is never kept unlocked in recents.
      const keep = !open && /\.(sx3mf|3mf)$/i.test(name) ? data.slice(0) : null
      told = (await addBytes(host, name, data, scope)) || told
      if (keep) void import('../project/autosave').then((m) => m.recordRecent(name, keep))
    }
    scope?.run(() => undefined)
    if (project && wasEmpty) {
      // Save writes back to an opened .sx3mf; another slicer's 3MF is saved as a new file.
      const only = refs.length === 1 ? refs[0] : undefined
      set({ projectFile: only?.path && /\.sx3mf$/i.test(only.name) ? only : null })
    }
    scope?.finish()
    if (scope && !scope.superseded) set((s) => ({ jobSeq: s.jobSeq + 1 }))
    if (!told || refs.length > 1) toast(refs.length === 1 ? `Added ${refs[0]?.name ?? 'model'}` : `Added ${refs.length} models`)
  } catch (e) {
    scope?.finish(false)
    // A newer open took over: it says what it opened.
    if (e instanceof OpenSuperseded) return
    toast(e instanceof Error ? e.message : 'Could not open the file')
  } finally {
    if (!scope?.superseded) {
      set({ plateLoading: false, sliceDuringOpen: false })
      markOpenEnded()
    }
  }
}
