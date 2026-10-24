// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange on a plate printed by object. The nest keeps the clearance radius between objects (its `apart`); this keeps
// the gantry rule the check and the engine hold the plate to (@slicerx/settings/by-object): an object taller than the
// gantry rod prints after every object in its lane. Tall objects print last, and when two or more are that tall each
// gets a lane of its own, so the gantry over a later one never meets an earlier one. The print order is the plate's
// own order, which the 3MF keeps and the engine prints in.
import type { Bed, SettingValue } from '@slicerx/contracts'
import { zoneKeep } from '@slicerx/settings/arrange-room'
import { arrangeRules, byObjectOrder, byObjectPlan, gantryLane, overRod } from '@slicerx/settings/by-object'
import type { PlateEntry } from '../state/store'
import { currentMargins, printSizeOf, type ArrangeOptions, type ArrangeResult } from './arrange'
import { plateShapes } from './sequence-check'
import { bounds, type Mat4 } from './transform'

/** Places `moving` around `fixed`: the nest, or the box packer when the engine cannot run (`boxes`). */
export type Place = (moving: readonly PlateEntry[], fixed: readonly PlateEntry[], opts: ArrangeOptions) => Promise<ArrangeResult & { boxes?: boolean }>

/** An arrange and the print order that goes with it, as ids. */
export interface ByObjectArrange extends ArrangeResult {
  order: string[]
}

const printed = (list: readonly PlateEntry[]) => list.filter((p) => p.printable !== false)

/** How many pairs and tall objects the check would name on these entries, printed in this order. */
function problems(entries: readonly PlateEntry[], cfg: Record<string, SettingValue>): number {
  const plan = byObjectPlan(plateShapes(printed(entries)), cfg)
  return plan.pairs.length + plan.tall.length
}

/** `plate` with `transforms` applied, in the order the gantry rule takes; objects left out of the print go after. */
function laidOut(plate: readonly PlateEntry[], transforms: Record<string, Mat4>, cfg: Record<string, SettingValue>): PlateEntry[] {
  const moved = plate.map((p) => (transforms[p.id] ? { ...p, transform: transforms[p.id]! } : p))
  const order = byObjectOrder(plateShapes(printed(moved)), cfg)
  const rank = new Map(order.map((id, i) => [id, i]))
  const at = (p: PlateEntry) => rank.get(p.id) ?? order.length + moved.indexOf(p)
  return [...moved].sort((x, y) => at(x) - at(y))
}

/**
 * Arranges `moving` around `fixed` on `plate` (every entry, in its order) for printing by object with `cfg`. The plain
 * arrange first, in the gantry's order; when that still leaves a tall object under the gantry and two or more are
 * tall, the tall ones go down one at a time, each clear of the lanes before it, and the rest around them. The lanes
 * layout counts only when it leaves fewer problems and no more objects off the bed. Arrange holds itself to the
 * check's rules with the rod reaching a little further (arrangeRules), so heimdall's slice agrees.
 */
export async function arrangeByObject(
  plate: readonly PlateEntry[],
  moving: readonly PlateEntry[],
  fixed: readonly PlateEntry[],
  bed: Bed,
  opts: ArrangeOptions,
  cfg: Record<string, SettingValue>,
  place: Place,
  stop?: () => boolean,
): Promise<ByObjectArrange> {
  cfg = arrangeRules(cfg)
  const first = await place(moving, fixed, opts)
  const plain = laidOut(plate, first.transforms, cfg)
  const keep = (): ByObjectArrange => ({ ...first, order: plain.map((p) => p.id) })
  const before = problems(plain, cfg)
  const shape = (e: PlateEntry) => plateShapes([e])[0]!
  const tall = printed(moving).filter((e) => overRod(shape(e).top, cfg))
  const fixedTall = printed(fixed).filter((e) => overRod(shape(e).top, cfg))
  if (before === 0 || tall.length === 0 || tall.length + fixedTall.length < 2 || stop?.()) return keep()
  // A whole-print skirt may not cross a zone, and a lane runs between the tall objects, so the lanes pass leaves it out.
  const margins = { ...(opts.margins ?? currentMargins()), skirt: false }
  // The footprints whose lanes the next tall object keeps out of.
  const hulls = fixedTall.map((e) => shape(e).hull)
  const depth = (e: PlateEntry) => {
    const b = bounds(e.parts, e.transform)
    return b ? b.max[1] - b.min[1] : 0
  }
  const transforms: Record<string, Mat4> = {}
  const down: PlateEntry[] = []
  for (const t of [...tall].sort((a, b) => depth(b) - depth(a))) {
    const b = bounds(t.parts, t.transform)
    const size = b ? printSizeOf(b) : { w: 0, h: 0, height: 0 }
    const away = zoneKeep(margins.grow(size), margins.reach(size), opts.gapMm, margins.apart, !first.boxes)
    const lanes = hulls.map((h) => gantryLane(h, cfg, 0, bed.widthMm, away))
    const r = await place([t], [...fixed, ...down], { ...opts, margins, zones: [...(opts.zones ?? []), ...lanes] })
    const m = r.transforms[t.id]
    if (!m || stop?.()) return keep()
    const at = { ...t, transform: m }
    down.push(at)
    transforms[t.id] = m
    hulls.push(shape(at).hull)
  }
  const low = moving.filter((e) => !tall.includes(e))
  const rest: ArrangeResult = low.length > 0 ? await place(low, [...fixed, ...down], opts) : { transforms: {}, leftOver: [], tooLarge: [] }
  Object.assign(transforms, rest.transforms)
  const laned = laidOut(plate, transforms, cfg)
  if (problems(laned, cfg) >= before || rest.leftOver.length > first.leftOver.length) return keep()
  return { transforms, leftOver: rest.leftOver, tooLarge: rest.tooLarge, order: laned.map((p) => p.id) }
}
