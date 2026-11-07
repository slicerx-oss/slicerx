// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Color paint from a model's texture: an OBJ opened with its MTL and images, or a 3MF with textures. The engine
// (sx-geom paint.texture) gives each part the filament nearest the texture's color, bit by bit, and the filament
// with the most area as the part's own; the result goes on the object as color paint in one undo step, the same paint
// the brush writes. The source stays while its objects are in the project, so the paint panel can paint again after the
// filaments change.
import type { MeshPart } from '@slicerx/contracts'
import { geom } from '../geom/client'
import { resolveSlots } from '../filament/slots'
import { fileSlotFor } from '../filament/pick'
import { activeMeta } from './plates'
import { history, inStep } from './history'
import { commitStroke, type StrokeEdits } from './paint'
import { appStore, get, markStale, set, toast, type PlateEntry } from '../state/store'

/** What a textured model was read from: an OBJ with its sibling files by name, or a 3MF. */
export type TextureSource =
  | { kind: 'obj'; name: string; obj: Uint8Array; files: Record<string, Uint8Array> }
  | { kind: '3mf'; name: string; data: Uint8Array }

export type TextureMode = 'nearest' | 'palette'

/** The engine's answer (sx-geom paint.texture). */
export interface TextureReply {
  textured: boolean
  parts: { slot: number | null; paint: Record<string, string>; painted: number }[]
  slots: { slot: number; areaMm2: number }[]
  colors: number[]
  palette: string[]
  leaves: number
  minEdgeMm?: number
  images: { name: string; width: number; height: number; fileWidth: number; fileHeight: number }[]
  notes: string[]
}

/** One object's paint from its texture, ready to apply. */
export interface TexturePlan {
  objectId: string
  edits: StrokeEdits[]
  /** File slot by part index, for the parts that take the filament with the most area as their own. */
  slots: Record<number, number>
  /** The filament colors the plan maps to, slot 1 first. */
  filaments: string[]
  reply: TextureReply
  /** The object's parts the plan was made for: its edits are by triangle of these meshes. */
  parts: readonly MeshPart[]
}

const sources = new Map<string, TextureSource>()
let stopWatching: (() => void) | null = null
/**
 * The meshes and color paint a texture paint left on each object. When a part's mesh is swapped and its paint is still
 * exactly that (the crossing check rebuilds a part and keeps its paint by triangle number), the paint sits on the wrong
 * triangles, so the object is painted again from its texture. Paint that changed with the mesh (carried onto the new
 * triangles, or brushed) is left alone.
 */
const painted = new Map<string, { parts: readonly MeshPart[]; colors: readonly (Record<number, string> | undefined)[] }>()
const repainting = new Map<string, Promise<void>>()

function projectIds(s = get()): Set<string> {
  return new Set([...s.plate.map((e) => e.id), ...s.plates.flatMap((p) => p.objects.map((o) => o.id))])
}

/** Lets go of the sources whose objects left the project (deleted, a new project, the open undone). */
function prune(): void {
  const ids = projectIds()
  for (const id of [...sources.keys()]) if (!ids.has(id)) sources.delete(id)
  for (const id of [...painted.keys()]) if (!sources.has(id)) painted.delete(id)
  if (!sources.size) {
    stopWatching?.()
    stopWatching = null
  }
}

/** The texture an object was opened with, while the object is in the project. */
export function textureSourceOf(objectId: string): TextureSource | undefined {
  return sources.get(objectId)
}

export function rememberTexture(objectId: string, source: TextureSource): void {
  sources.set(objectId, source)
  stopWatching ??= appStore.subscribe((s, p) => {
    if (s.plate !== p.plate || s.plates !== p.plates) prune()
    if (s.plate !== p.plate) checkSwapped(s.plate)
  })
  prune()
}

/** Notes the meshes and color paint a texture paint left on an object. */
function notePainted(e: PlateEntry): void {
  painted.set(e.id, { parts: [...e.parts], colors: e.parts.map((_, i) => e.paint?.[i]?.color) })
}

/** Paints an object again from its texture when a part's mesh changed under paint the texture left as it was. */
function checkSwapped(plate: readonly PlateEntry[]): void {
  for (const [id, was] of painted) {
    if (repainting.has(id)) continue
    const e = plate.find((x) => x.id === id)
    if (!e) continue
    const moved = e.parts.length !== was.parts.length || e.parts.some((p, i) => p !== was.parts[i])
    if (!moved) continue
    const stale = e.parts.some((p, i) => p !== was.parts[i] && was.colors[i] !== undefined && e.paint?.[i]?.color === was.colors[i])
    if (!stale) {
      // the paint moved with the mesh, or was changed since: not the texture's to redo
      painted.delete(id)
      continue
    }
    const run = repaint(id).finally(() => repainting.delete(id))
    repainting.set(id, run)
  }
}

async function repaint(id: string): Promise<void> {
  const src = sources.get(id)
  painted.delete(id)
  if (!src) return
  try {
    const filaments = filamentColors()
    if (filaments.length < 2) return
    for (let tries = 0; tries < 3; tries++) {
      const e = get().plate.find((x) => x.id === id)
      if (!e) return
      const plan = await planTexturePaint(e, src, 'nearest', filaments)
      if (!plan.reply.textured) return
      if (applyTexturePlans([plan], undefined, { quiet: true }) !== null) return
    }
  } catch (e) {
    console.warn('paint from texture after a mesh change', e)
  }
}

/** Waits for the repaints a mesh change started (for tests and callers that read the paint next). */
export async function textureRepaints(): Promise<void> {
  while (repainting.size) await Promise.all([...repainting.values()])
}

export function forgetTexture(objectId: string): void {
  sources.delete(objectId)
  prune()
}

/** Image names an OBJ's MTL files point at, and the MTL files the OBJ names (by their own names). */
export function objCompanions(obj: Uint8Array, files: Record<string, Uint8Array>): { mtl: string[]; images: string[]; missing: string[] } {
  const dec = new TextDecoder()
  const mtl = [...dec.decode(obj).matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/\\/g, '/'))
  const images: string[] = []
  for (const m of mtl) {
    const text = files[m] ?? files[m.split('/').pop()!]
    if (!text) continue
    for (const line of dec.decode(text).split(/\r?\n/)) {
      const hit = /^\s*map_Kd\s+(.+?)\s*$/i.exec(line)
      if (!hit) continue
      // options come first, each with its values; the name is the rest
      const toks = hit[1]!.split(/\s+/)
      let i = 0
      while (i < toks.length && toks[i]!.startsWith('-')) {
        const o = toks[i]!
        i += 1
        if (o === '-o' || o === '-s' || o === '-t') for (let n = 0; n < 3 && i < toks.length && !Number.isNaN(Number(toks[i])); n++) i += 1
        else i += o === '-mm' ? 2 : 1
      }
      const name = toks.slice(i).join(' ').replace(/\\/g, '/')
      if (name && !images.includes(name)) images.push(name)
    }
  }
  const has = (n: string) => n in files || n.split('/').pop()! in files
  return { mtl, images, missing: [...mtl, ...images].filter((n) => !has(n)) }
}

/** Whether a 3MF may hold a texture, by its entry names: an image that is not a thumbnail or a plate picture. */
export function threemfMayHaveTextures(names: readonly string[]): boolean {
  return names.some((n) => /\.(png|jpe?g)$/i.test(n) && !/^(Metadata|Thumbnails)\//i.test(n) && !/thumbnail/i.test(n))
}

const GROUP = new TextEncoder().encode('texture2dgroup')

/** Whether a 3MF model file's XML has a texture2dgroup, the only way its meshes use a texture. */
export function modelHasTextures(xml: Uint8Array): boolean {
  outer: for (let i = 0; i + GROUP.length <= xml.length; i++) {
    for (let k = 0; k < GROUP.length; k++) if (xml[i + k] !== GROUP[k]) continue outer
    return true
  }
  return false
}

/** The filament colors paint states stand for, slot 1 first, as the paint panel shows them. */
export function filamentColors(): string[] {
  return resolveSlots(get()).map((s) => s.color)
}

/** Whether "pick colors from the texture" may set the filament colors: none is set by hand or by the printer. */
export function paletteAllowed(): boolean {
  const slots = resolveSlots(get())
  return slots.length >= 2 && slots.every((s) => s.source === 'default' || s.source === 'model')
}

/** What a failed paint from a texture says; the engine's own words go to the console. */
export const TEXTURE_FAILED = 'The texture could not be painted. Check that the OBJ opens with its MTL and images.'

/** "1", "1 and 2", "1, 2 and 5". */
export function listSlots(slots: readonly number[]): string {
  if (slots.length <= 1) return slots.join('')
  return `${slots.slice(0, -1).join(', ')} and ${slots[slots.length - 1]}`
}

/** What a paint from a texture did, for the toast: "Painted from texture: 4 colors to filaments 1, 2, 3 and 5". */
export function paintedText(slots: readonly number[]): string {
  const n = slots.length
  return `Painted from texture: ${n} ${n === 1 ? 'color' : 'colors'} to ${n === 1 ? 'filament' : 'filaments'} ${listSlots(slots)}`
}

/** The filament setup with the palette's colors on slots 1 and on, each keeping its material. */
function paletteSetup(s: ReturnType<typeof get>, palette: readonly string[]): ReturnType<typeof get>['slotSetup'] {
  const now = resolveSlots(s)
  const next = { ...s.slotSetup }
  palette.forEach((color, i) => {
    const r = now[i]
    next[i + 1] = { ...(s.slotSetup[i + 1] ?? { type: r?.type ?? 'PLA', brand: r?.brand ?? '' }), color }
  })
  return next
}

function scaleOf(t: readonly number[]): number {
  const col = (k: number) => Math.hypot(t[k]!, t[k + 1]!, t[k + 2]!)
  const s = Math.max(col(0), col(4), col(8))
  return Number.isFinite(s) && s > 0 ? s : 1
}

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

function sourceRequest(src: TextureSource): Record<string, unknown> {
  if (src.kind === '3mf') return { threemf: { base64: base64(src.data) } }
  return { obj: { base64: base64(src.obj) }, files: Object.fromEntries(Object.entries(src.files).map(([k, v]) => [k, base64(v)])) }
}

/**
 * The engine's paint for one object, as edits on its parts (nothing changes yet). A part's own filament is kept by
 * part name, so parts that share a name keep every filament as paint and their own filament stays as it is.
 */
export async function planTexturePaint(entry: Pick<PlateEntry, 'id' | 'parts' | 'paint' | 'transform'>, src: TextureSource, mode: TextureMode = 'nearest', filaments = filamentColors()): Promise<TexturePlan> {
  const at = { parts: entry.parts }
  const parts = entry.parts.map((p: MeshPart) => ({ positions: p.positions, indices: p.indices }))
  const count = new Map<string, number>()
  for (const p of entry.parts) count.set(p.name, (count.get(p.name) ?? 0) + 1)
  const paintEvery = entry.parts.flatMap((p, i) => ((count.get(p.name) ?? 0) > 1 ? [i] : []))
  const reply = await geom().call<TextureReply>('paint.texture', { source: sourceRequest(src), parts, filaments, mode, scale: scaleOf(entry.transform), ...(paintEvery.length ? { paintEvery } : {}) })
  const edits: StrokeEdits[] = []
  const slots: Record<number, number> = {}
  if (!reply.textured) return { objectId: entry.id, edits, slots, filaments, reply, ...at }
  const meta = activeMeta()
  reply.parts.forEach((r, i) => {
    const part = entry.parts[i]
    if (!part || r.slot === null) return
    // the texture's paint takes the place of the part's color paint
    const old = entry.paint?.[i]?.color ?? {}
    const changed: StrokeEdits['edits'][number][] = []
    for (const k of Object.keys(old)) if (!(k in r.paint)) changed.push({ triangle: Number(k), after: null })
    for (const [k, text] of Object.entries(r.paint)) if (old[Number(k)] !== text) changed.push({ triangle: Number(k), after: text })
    if (changed.length) edits.push({ objectId: entry.id, partIndex: i, layer: 'color', edits: changed })
    if (!paintEvery.includes(i)) slots[i] = fileSlotFor(meta, r.slot)
  })
  return { objectId: entry.id, edits, slots, filaments, reply, ...at }
}

/** The part filament overrides a plan leaves on its object, by part name. */
function overridesAfter(e: PlateEntry, plan: TexturePlan): Record<string, number> {
  const next = { ...(e.slotOverrides ?? {}) }
  e.handle.parts.forEach((p, i) => {
    const to = plan.slots[i]
    if (to === undefined) return
    if (to === p.slot) delete next[p.name]
    else next[p.name] = to
  })
  return next
}

function sameRecord(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

/** Whether applying the plans changes the project: paint, a part's own filament, or the filament colors. */
export function texturePlansChange(plans: readonly TexturePlan[], palette?: readonly string[]): boolean {
  if (plans.some((p) => p.edits.length)) return true
  const s = get()
  for (const plan of plans) {
    const e = s.plate.find((x) => x.id === plan.objectId)
    if (e && !sameRecord(overridesAfter(e, plan), e.slotOverrides ?? {})) return true
  }
  if (!palette?.length) return false
  const now = resolveSlots(s)
  return palette.some((c, i) => now[i]?.color.toLowerCase() !== c.toLowerCase())
}

/** Whether an object still has the meshes a plan was made for (its edits are by their triangle numbers). */
export function planCurrent(plan: TexturePlan): boolean {
  const e = get().plate.find((x) => x.id === plan.objectId)
  return !!e && e.parts === plan.parts
}

/**
 * Applies plans as one undo step: the paint, each part's own filament and, from a palette, the filament colors (set
 * as the person's own, so Undo takes them back too). Says what it did in a toast with Undo, unless `quiet`. Applies
 * nothing and answers null when an object's meshes changed since its plan was made.
 */
export function applyTexturePlans(plans: readonly TexturePlan[], palette?: readonly string[], opts: { quiet?: boolean } = {}): number[] | null {
  if (!plans.every(planCurrent)) return null
  const used = [...new Set(plans.flatMap((p) => p.reply.colors))].sort((a, b) => a - b)
  if (!texturePlansChange(plans, palette)) return []
  inStep({}, () => {
    for (const plan of plans) for (const e of plan.edits) commitStroke(e)
    set((s) => ({
      plate: s.plate.map((e) => {
        const plan = plans.find((p) => p.objectId === e.id)
        if (!plan || !Object.keys(plan.slots).length) return e
        const next = overridesAfter(e, plan)
        const { slotOverrides: _old, ...rest } = e
        return { ...rest, ...(Object.keys(next).length ? { slotOverrides: next } : {}) } as PlateEntry
      }),
      ...(palette?.length ? { slotSetup: paletteSetup(s, palette) } : {}),
    }))
  })
  const s = get()
  for (const plan of plans) {
    const e = s.plate.find((x) => x.id === plan.objectId)
    if (e) notePainted(e)
  }
  markStale()
  if (!opts.quiet) toast(`${paintedText(used)}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  return used
}

/**
 * Paints the objects an open just put on the plate from the texture they came with. With fewer than two filaments
 * there is nothing to pick between, so it only says how to paint later.
 */
export async function paintOpenedFromTexture(objectIds: readonly string[], src: TextureSource): Promise<number[] | null> {
  // every object the open added keeps its source, on any plate; the shown plate's are painted now
  const ids = projectIds()
  for (const id of objectIds) if (ids.has(id)) rememberTexture(id, src)
  const entries = get().plate.filter((e) => objectIds.includes(e.id) && e.parts.length > 0)
  if (!entries.length) return null
  const filaments = filamentColors()
  if (filaments.length < 2) {
    toast(`${src.name} has a texture. Set up two or more filaments, then paint it from the texture in the paint tool.`, 'info')
    return null
  }
  try {
    const plans: TexturePlan[] = []
    for (const e of entries) plans.push(await planTexturePaint(e, src, 'nearest', filaments))
    // a part rebuilt while the engine painted (the crossing check) is painted again on its new mesh
    for (let tries = 0; tries < 3 && !plans.every(planCurrent); tries++) {
      for (let k = 0; k < plans.length; k++) {
        if (planCurrent(plans[k]!)) continue
        const now = get().plate.find((x) => x.id === plans[k]!.objectId)
        if (now) plans[k] = await planTexturePaint(now, src, 'nearest', filaments)
      }
    }
    const kept = plans.filter(planCurrent)
    const notes = [...new Set(plans.flatMap((p) => p.reply.notes))]
    if (!plans.some((p) => p.reply.textured)) {
      // nothing there to paint from: the file is not kept
      for (const id of objectIds) forgetTexture(id)
      if (notes.length) toast(`${src.name}: ${notes.join(' ')}`, 'warn')
      return null
    }
    const used = applyTexturePlans(kept) ?? []
    if (notes.length) toast(`${paintedText(used)}. ${notes.join(' ')}`, 'warn', { label: 'Undo', run: () => void history().undo() })
    return used
  } catch (e) {
    console.warn('paint from texture', e)
    toast(TEXTURE_FAILED, 'warn')
    return null
  }
}
