// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mixed filaments: two loaded filaments printed on alternating layers in a ratio, under a filament number of their own
// that parts and paint use like any other (@slicerx/settings/mixed has the rules the engine shares). Like the loaded
// filaments, the mixes belong to the project: a number means the same mix on every plate, so moving, copying or
// arranging an object never needs to touch them. Each plate's slice sends only the mixes its objects use.
import { MAX_MIXES, MIX_LOWEST_ID, MIX_TOP_ID, mixColor, mixProblem, nextMixId, type MixedFilament } from '@slicerx/settings/mixed'
import { remapEntry } from '../plate/paint-states'
import { history, inStep } from '../plate/history'
import { slotCount } from './slots'
import { appStore, get, markStale, set, toast, type AppState } from '../state/store'

export type { MixedFilament }

/** The project's mixes. */
export function mixesOf(s: Pick<AppState, 'mixes'>): readonly MixedFilament[] {
  return s.mixes ?? []
}

/** The mix filament number `slot` names, if it is one. */
export function mixOf(s: Pick<AppState, 'mixes'>, slot: number): MixedFilament | undefined {
  return mixesOf(s).find((m) => m.id === slot)
}

/** The loaded filaments a slot prints with: itself, or a mix's two. */
export function slotFilaments(s: Pick<AppState, 'mixes'>, slot: number): number[] {
  const m = mixOf(s, slot)
  return m ? [...m.components] : [slot]
}

/** A mix's predicted color from the colors of the filaments it mixes (`colors[i]` is filament i + 1's). */
export function mixSwatch(m: Pick<MixedFilament, 'components' | 'ratio'>, colors: readonly string[]): { color: string; a: string; b: string } {
  const a = colors[m.components[0] - 1] ?? '#808080'
  const b = colors[m.components[1] - 1] ?? '#808080'
  return { color: mixColor([a, b], m.ratio), a, b }
}

/**
 * The color of each filament number up to the highest mix's, for the 3D view: the loaded filaments' colors, then each
 * mix at its own number in its predicted color. Numbers between them repeat the last filament's.
 */
export function colorsWithMixes(s: Pick<AppState, 'mixes'>, colors: readonly string[]): string[] {
  const mixes = mixesOf(s)
  if (!mixes.length) return [...colors]
  const top = Math.max(colors.length, ...mixes.map((m) => m.id))
  const out = Array.from({ length: top }, (_, i) => colors[i] ?? colors.at(-1) ?? '#808080')
  for (const m of mixes) out[m.id - 1] = mixSwatch(m, colors).color
  return out
}

/** The CSS background of a mix's swatch: stripes of its two colors in its ratio. */
export function stripes(m: Pick<MixedFilament, 'components' | 'ratio'>, colors: readonly string[]): string {
  const { a, b } = mixSwatch(m, colors)
  const [ra, rb] = m.ratio
  const unit = 4
  const end = (ra + rb) * unit
  return `repeating-linear-gradient(135deg, ${a} 0 ${ra * unit}px, ${b} ${ra * unit}px ${end}px)`
}

function writeMixes(mixes: MixedFilament[]): void {
  set({ mixes })
  markStale()
}

/** Adds a mix to the project and returns it, or a reason it cannot. One undo step. */
export function addMix(patch: Omit<MixedFilament, 'id'>, loaded: number): MixedFilament | string {
  const mixes = mixesOf(get())
  const id = nextMixId(mixes, loaded)
  if (id === null) return `A project holds ${Math.min(MAX_MIXES, Math.max(0, MIX_TOP_ID - loaded))} mixes at most.`
  const m: MixedFilament = { ...patch, id, name: patch.name.trim() }
  const bad = mixProblem(m, [...mixes, m], loaded)
  if (bad) return bad
  history()
  inStep({}, () => writeMixes([...mixes, m]))
  return m
}

/** Changes mix `id`; what is not given stays. Returns the mix, or a reason it cannot. One undo step. */
export function updateMix(id: number, patch: Partial<Omit<MixedFilament, 'id'>>, loaded: number): MixedFilament | string {
  const mixes = mixesOf(get())
  const cur = mixes.find((m) => m.id === id)
  if (!cur) return `This project has no mix ${id}.`
  const m: MixedFilament = { ...cur, ...patch, id, name: (patch.name ?? cur.name).trim() }
  const next = mixes.map((o) => (o.id === id ? m : o))
  const bad = mixProblem(m, next, loaded)
  if (bad) return bad
  history()
  inStep({}, () => writeMixes(next))
  return m
}

/**
 * Moves what every plate's objects print on mixes `gone` (their parts and color paint) to each mix's first filament,
 * so nothing is left on a number no filament has. Part of the caller's undo step.
 */
export function retireMixes(gone: readonly MixedFilament[]): void {
  if (!gone.length) return
  const map = new Map(gone.map((m) => [m.id, m.components[0]] as const))
  set((s) => ({ plate: s.plate.map((e) => remapEntry(e, map)), plates: s.plates.map((p) => ({ ...p, objects: p.objects.map((e) => remapEntry(e, map)) })) }))
}

/** Removes mix `id`. Parts and paint on it, on every plate, go back to its first filament. One undo step. */
export function removeMix(id: number): boolean {
  const mixes = mixesOf(get())
  const cur = mixes.find((m) => m.id === id)
  if (!cur) return false
  history()
  inStep({}, () => {
    writeMixes(mixes.filter((m) => m.id !== id))
    retireMixes([cur])
  })
  return true
}

/**
 * Makes `next` the project's mixes, as a client's whole list: a mix it drops takes its parts and paint back to its first
 * filament, as Delete mix does. Returns the reason the list cannot be used, or null. One undo step.
 */
export function setMixes(next: readonly MixedFilament[], loaded: number): string | null {
  for (const m of next) {
    const bad = mixProblem(m, next, loaded)
    if (bad) return `mix ${m.id}: ${bad}`
  }
  if (next.length > MAX_MIXES) return `A project holds ${MAX_MIXES} mixes at most.`
  const before = mixesOf(get())
  const gone = before.filter((m) => !next.some((n) => n.id === m.id))
  history()
  inStep({}, () => {
    writeMixes(next.map((m) => ({ ...m, components: [...m.components] as [number, number], ratio: [...m.ratio] as [number, number] })))
    retireMixes(gone)
  })
  return null
}

/**
 * The mixes `incoming` (a file's) added to `base` (the project's): one already there, the same, is shared; one whose
 * number another mix holds takes a free number. Returns the list and the numbers to rewrite in what came with
 * `incoming`; one with no free number left maps to its first filament.
 */
export function mergeMixes(base: readonly MixedFilament[], incoming: readonly MixedFilament[], loaded: number): { mixes: MixedFilament[]; map: Map<number, number> } {
  const out = [...base]
  const map = new Map<number, number>()
  const same = (a: MixedFilament, b: MixedFilament) => a.components.join() === b.components.join() && a.ratio.join() === b.ratio.join()
  for (const m of incoming) {
    const twin = out.find((o) => same(o, m))
    if (twin) {
      if (twin.id !== m.id) map.set(m.id, twin.id)
      continue
    }
    const id = m.id > loaded && m.id >= MIX_LOWEST_ID && out.length < MAX_MIXES && !out.some((o) => o.id === m.id) ? m.id : nextMixId(out, loaded)
    if (id === null) {
      map.set(m.id, m.components[0])
      continue
    }
    out.push({ ...m, id })
    if (id !== m.id) map.set(m.id, id)
  }
  return { mixes: out, map }
}

/** What a mix would cost on the shown plate, and what the estimate is based on. */
export interface MixEstimate {
  /** Tool changes it adds. */
  changes: number
  /** Flush they purge, grams. */
  grams: number
  /** Enough changes to warn about. */
  many: boolean
  /** Layers the estimate counts. */
  layers: number
  /** The parts on the mix set the height, or with none on it yet the tallest object on the plate; none on an empty plate. */
  basis: 'parts' | 'tallest' | 'none'
}

/**
 * The tool changes and flush grams mix `m` adds on the shown plate: over the layers of the objects on it (the tallest
 * object's, when nothing is on it yet), each switch of filament purging the flush matrix's volume for that pair (the
 * one the slice uses: auto from the colors, or set by hand) times the flush multiplier, at the filament's density.
 */
export async function mixEstimate(s: AppState, m: MixedFilament): Promise<MixEstimate> {
  const [{ bounds }, { resolveConfig }, { flushPlan }, { flushMatrix }, { resolveSlots }, { mixCost }] = await Promise.all([
    import('../plate/transform'),
    import('../adapters/config'),
    import('./slot-config'),
    import('./flush'),
    import('./slots'),
    import('@slicerx/settings/mixed'),
  ])
  const height = (ids: (e: PlateEntryLike) => boolean): number => s.plate.filter(ids).reduce((h, e) => Math.max(h, bounds(e.parts, e.transform)?.max[2] ?? 0), 0)
  const on = (e: PlateEntryLike) => e.printable !== false && e.handle.parts.some((p) => (e.slotOverrides?.[p.name] ?? p.slot) === m.id)
  const own = height(on)
  const tall = own > 0 ? own : height((e) => e.printable !== false)
  const basis: MixEstimate['basis'] = own > 0 ? 'parts' : tall > 0 ? 'tallest' : 'none'
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, unknown>
  const num = (v: unknown, d: number): number => {
    const x = Number(Array.isArray(v) ? v[0] : v)
    return Number.isFinite(x) && x > 0 ? x : d
  }
  const lh = num(cfg['layer_height'], 0.2)
  const first = num(cfg['initial_layer_print_height'], lh)
  const layers = tall > first ? Math.ceil((tall - first) / lh - 1e-6) + 1 : tall > 0 ? 1 : 0
  const slots = resolveSlots(s)
  const n = Math.max(slots.length, ...m.components)
  const plan = flushPlan(s, n)
  const z = plan.nozzles[0] ?? { mins: plan.mins, dataset: plan.dataset }
  const matrix = flushMatrix(Array.from({ length: n }, (_, i) => slots[i]?.color ?? '#808080'), s.flush, z.mins, z.dataset)
  const [a, b] = m.components
  // The matrix takes the values set by hand over the auto ones, as the slice does.
  const vol = (from: number, to: number): number => matrix[from - 1]?.[to - 1] ?? 0
  const density = (slot: number): number => {
    const d = cfg['filament_density']
    return num(Array.isArray(d) ? (d[slot - 1] ?? d[0]) : d, 1.24)
  }
  const cost = mixCost(m, layers, [vol(a, b), vol(b, a)], plan.multiplier, [density(a), density(b)])
  return { ...cost, layers, basis }
}

type PlateEntryLike = AppState['plate'][number]

/**
 * The numbers mixes `mixes` move to so none is at or below `floor` (the printer's filament count, or the filaments the
 * project needs if more): the free numbers above it, the highest mix taking the highest, so they keep their order.
 * Old number to new for the mixes that move; empty when none is in the way, null when there are too few numbers.
 */
export function clearOfFloor(mixes: readonly MixedFilament[], floor: number): Map<number, number> | null {
  if (!mixes.some((m) => m.id <= floor)) return new Map()
  const free: number[] = []
  for (let id = MIX_TOP_ID; id > Math.max(floor, MIX_LOWEST_ID - 1) && free.length < mixes.length; id--) free.push(id)
  if (free.length < mixes.length) return null
  const map = new Map<number, number>()
  ;[...mixes].sort((a, b) => b.id - a.id).forEach((m, i) => {
    if (free[i] !== m.id) map.set(m.id, free[i]!)
  })
  return map
}

/**
 * Moves the mixes clear of a printer that reports filaments up to a mix's number (one with more slots connected after
 * the mix was made): each takes a free number above the printer's filaments, and the parts and color paint on it, on
 * every plate, follow, in one undo step. Returns the numbers that moved, or null when nothing moved; with too few
 * free numbers nothing moves and the Mixes row says so ([`printerClash`]).
 */
export function clearMixesOfPrinter(): Map<number, number> | null {
  const s = get()
  const mixes = mixesOf(s)
  // The filaments the project needs; slotCount leaves the mixes' own numbers out.
  const floor = Math.max(s.printerSlots.length, slotCount(s))
  const map = clearOfFloor(mixes, floor)
  if (!map || !map.size) return null
  history()
  inStep({}, () => {
    writeMixes(mixes.map((m) => ({ ...m, id: map.get(m.id) ?? m.id })))
    set((st) => ({ plate: st.plate.map((e) => remapEntry(e, map)), plates: st.plates.map((p) => ({ ...p, objects: p.objects.map((e) => remapEntry(e, map)) })) }))
  })
  const moved = [...map].map(([from, to]) => `${from} to ${to}`).join(', ')
  toast(`Mixes moved clear of the printer's ${s.printerSlots.length} filaments: ${moved}. Parts and paint on them moved too.`, 'info')
  return map
}

// A printer that reports more filaments moves the mixes out of its way: after the change that brought its slots has
// reached every listener, so the move is an undo step of its own.
appStore.subscribe((s, prev) => {
  if (s.printerSlots === prev.printerSlots || !mixesOf(s).some((m) => m.id <= s.printerSlots.length)) return
  queueMicrotask(() => void clearMixesOfPrinter())
})

/**
 * When the printer reports filaments up to a mix's number and the mixes cannot move clear of them (too few free
 * numbers above), what to tell the person: that number names both, and parts on it print as the mix until it goes. Null
 * when no mix is in the way, or when the mixes can still move ([`clearMixesOfPrinter`] does that).
 */
export function printerClash(s: Pick<AppState, 'mixes' | 'printerSlots'>): string | null {
  const n = s.printerSlots.length
  const hit = mixesOf(s).filter((m) => m.id <= n).sort((a, b) => a.id - b.id)[0]
  if (!hit || clearOfFloor(mixesOf(s), n)) return null
  return `The printer reports ${n} filaments, so filament ${hit.id} is also mix ${hit.name}'s number, and the mixes have no free number above them. Delete a mix before slicing.`
}
