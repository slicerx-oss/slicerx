// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange in the engine, where the host has it (the desktop, SlicerHost.arrangePlate): the call `sx arrange --request`
// and the MCP server's slicerx_arrange_file make, so the app lands on the same layout for the same plate and settings.
// The request is the slice's own plate and settings (engine-check.ts plateRequest) with placement arrange, the meshes
// the ones the host already holds; the engine works out the nest, the keep-out zones, the by-object clearance and the
// gantry lanes, and names the objects it found no room for. The answer is the engine's layout as transforms on the
// plate. Without the engine (the web and the phone) Arrange nests in the geometry worker (nest.ts), held to the same
// layouts by packages/settings/fixtures/arrange-golden.json.
import type { ArrangeSpec, Bed, PlateArrangement, SlicerHost } from '@slicerx/contracts'
import type { AppState, PlateEntry } from '../state/store'
import type { ArrangeOptions, ArrangeResult } from './arrange'
import { bedCircle } from './bed-shape'
import { areaOrigin } from './bed-origin'
import { bounds, type Mat4 } from './transform'

type Engine = Pick<SlicerHost, 'loadModel'> & Required<Pick<SlicerHost, 'arrangePlate'>>

let engine: Engine | null = null

/** Arrange goes through `slicer`'s engine from now on, when it has one; the function returned undoes it. */
export function setArrangeEngine(slicer: SlicerHost): () => void {
  if (!slicer.arrangePlate) return () => undefined
  const mine = slicer as Engine
  engine = mine
  return () => {
    if (engine === mine) engine = null
  }
}

/** Whether Arrange runs in the engine. */
export const arrangesInEngine = (): boolean => engine !== null

/** What an arrange with `opts` asks the engine for, the objects in `keep` staying where they are. */
export function arrangeSpec(opts: ArrangeOptions, keep: readonly string[] = []): ArrangeSpec {
  return {
    spacingMm: opts.gapMm,
    rotate: opts.rotate,
    ...(opts.rotate && opts.stepDeg !== undefined ? { stepDeg: opts.stepDeg } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(keep.length ? { keep: [...keep] } : {}),
  }
}

/**
 * Whether an object the engine found too large would fit an empty bed without its brim and skirt, on its bounds as
 * the box packer counts it: the notice then says the margins make it so.
 */
function fitsWithoutMargin(e: PlateEntry, bed: Bed, gapMm: number, rotate: boolean): boolean {
  const b = bounds(e.parts, e.transform)
  if (!b) return false
  const w = b.max[0] - b.min[0]
  const h = b.max[1] - b.min[1]
  const circle = bedCircle(bed)
  const fits = (x: number, y: number) => (circle ? Math.hypot(x, y) / 2 + gapMm <= circle.r + 1e-6 : x + 2 * gapMm <= bed.widthMm + 1e-6 && y + 2 * gapMm <= bed.depthMm + 1e-6)
  return fits(w, h) || (rotate && fits(h, w))
}

/** The engine's layout as an arrange of `entries`: new transforms on the plate, and the objects with no room. */
export function arrangeResultOf(report: PlateArrangement, entries: readonly PlateEntry[], s: Pick<AppState, 'bed'>, origin: readonly [number, number], opts: ArrangeOptions): ArrangeResult & { report: PlateArrangement; order?: string[] } {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const transforms: Record<string, Mat4> = {}
  for (const o of report.objects) {
    if (!byId.has(o.id)) continue
    const t = [...o.transform]
    // the engine answers in machine coordinates; the plate counts from the printable area's front left corner
    t[12] = (t[12] ?? 0) - origin[0]
    t[13] = (t[13] ?? 0) - origin[1]
    transforms[o.id] = t
  }
  const left = report.notFit.filter((o) => byId.has(o.id))
  const tooLarge = left.filter((o) => o.reason === 'too_large').map((o) => ({ id: o.id, withoutMargin: fitsWithoutMargin(byId.get(o.id)!, s.bed, opts.gapMm, opts.rotate) }))
  // Printing by object the engine may print a tall part after the low ones under its gantry: the plate takes its order.
  return { transforms, leftOver: left.map((o) => o.id), tooLarge, report, ...(report.order?.length ? { order: report.order } : {}) }
}

/** The engine's new plates (`plates`, with newPlates) as layouts on the plate: each one's transforms and print order. */
export interface EngineNewPlate {
  transforms: Record<string, Mat4>
  order?: string[]
}

/**
 * Arranges `entries` of the shown plate in the engine, the ones in `keep` staying where they are. Entries left out of
 * the print are not sent, so they stay too. The objects with no room come back laid out on new plates (`plates`), in
 * the same call. `onLayout` gets the plate's first layout before the engine's plate check runs on it, when the host
 * can send it. Rejects when the engine refuses the plate.
 */
export async function engineArrange(s: AppState, entries: readonly PlateEntry[], keep: readonly PlateEntry[], opts: ArrangeOptions, onLayout?: (first: ArrangeResult) => void): Promise<ArrangeResult & { report: PlateArrangement; order?: string[]; plates: EngineNewPlate[] }> {
  const slicer = engine
  if (!slicer) throw new Error('This host has no engine arrange')
  const { plateRequest } = await import('./engine-check')
  const printed = entries.filter((e) => e.printable !== false)
  const kept = new Set(keep.map((k) => k.id))
  if (!printed.some((e) => !kept.has(e.id))) return { transforms: {}, leftOver: [], tooLarge: [], report: { byObject: false, spacingMm: opts.gapMm, rotate: opts.rotate, lanes: false, keepOut: [], objects: [], notFit: [] }, plates: [] }
  const req = await plateRequest(slicer, s, printed)
  req.plate = { ...req.plate, placement: 'arrange', arrange: { ...arrangeSpec(opts, printed.filter((e) => kept.has(e.id)).map((e) => e.id)), newPlates: true } }
  const { resolveConfig } = await import('../adapters/config')
  const origin = areaOrigin(resolveConfig(s.easy, s.overrides)['printable_area'])
  const moving = printed.filter((e) => !kept.has(e.id))
  const report = await slicer.arrangePlate(req, onLayout ? { onLayout: (first) => onLayout(arrangeResultOf(first, moving, s, origin, opts)) } : undefined)
  const plates = (report.plates ?? []).map((p) => {
    const r = arrangeResultOf({ ...report, objects: p.objects, notFit: [], order: p.order ?? [] }, moving, s, origin, opts)
    return { transforms: r.transforms, ...(r.order ? { order: r.order } : {}) }
  })
  return { ...arrangeResultOf(report, moving, s, origin, opts), plates }
}
