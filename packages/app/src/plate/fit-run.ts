// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fit check (sx-geom fit.check) on the plate. Inside one object, parts that touch are one piece, the way Orca
// joins an object's parts, so they never warn; gaps narrower than the printer keeps open do, and so do parts that come
// close without touching (they print loose). Between objects, any touch or tight gap counts: separate objects that
// meet print as one piece by accident.
import { fitCheck, type FitGap, type FitReport } from '../geom/cad'
import { toGeom, usesWorker, type GeomMesh } from '../geom/client'
import { bounds, type Box } from './transform'
import type { PlateEntry } from '../state/store'
import { setFit, type Touch } from './fit-state'

/** Pieces of one object this close without touching look meant to touch: the gap is worth a note. */
export const APART_MM = 1

/**
 * Gaps worth telling the person about inside one object, numbered by part: tight ones and pieces that do not touch,
 * never parts that touch. The check numbers bodies, not parts; each body says which part (mesh) it came from.
 */
export function objectGaps(report: FitReport): FitGap[] {
  const part = (k: number) => report.parts[k]?.item ?? k
  return report.gaps.filter((g) => g.kind !== 'fused').map((g) => ({ ...g, parts: [part(g.parts[0]), part(g.parts[1])] }))
}

/**
 * A part as the fit check sends it. The app's own geometry worker takes the typed arrays as they are and flattens them
 * itself (geom-worker.ts), so a model of millions of triangles is not turned into JS arrays on the page; another
 * provider gets plain arrays.
 */
function fitMesh(part: PlateEntry['parts'][number]): GeomMesh {
  return usesWorker() ? ({ positions: part.positions, indices: part.indices } as unknown as GeomMesh) : toGeom(part)
}

/** Whether two boxes come within `reach` of each other on every axis. */
export function near(a: Box, b: Box, reach: number): boolean {
  return [0, 1, 2].every((k) => a.min[k]! - reach <= b.max[k]! && b.min[k]! - reach <= a.max[k]!)
}

/** The closest gap between bodies of different meshes, from a check of two meshes. */
export function crossGap(report: FitReport): FitGap | null {
  const item = (k: number) => report.parts[k]?.item ?? -1
  const across = report.gaps.filter((g) => item(g.parts[0]) !== item(g.parts[1]))
  return across.reduce<FitGap | null>((best, g) => (!best || g.gapMm < best.gapMm ? g : best), null)
}

export async function checkObject(e: PlateEntry, minGapMm: number, layerHeightMm: number, signal: AbortSignal): Promise<void> {
  const parts = e.parts.map((p) => ({ mesh: fitMesh(p), transform: e.transform }))
  const report = await fitCheck(parts, { minGapMm, layerHeightMm, skipFused: true, apartMm: APART_MM }, signal)
  if (signal.aborted) return
  setFit(e.id, { gaps: objectGaps(report), names: e.parts.map((p) => p.name), limitMm: report.limitMm, verticalLimitMm: report.verticalLimitMm, transform: e.transform })
}

/** Separate objects that touch: only boxes that come close are measured, part against part. */
export async function checkTouches(entries: readonly PlateEntry[], minGapMm: number, layerHeightMm: number, signal: AbortSignal): Promise<Touch[]> {
  const reach = Math.max(minGapMm, layerHeightMm)
  const boxed = entries.flatMap((e) => {
    const box = bounds(e.parts, e.transform)
    return box ? [{ e, box }] : []
  })
  const out: Touch[] = []
  for (let i = 0; i < boxed.length; i++) {
    for (let j = i + 1; j < boxed.length; j++) {
      const a = boxed[i]!
      const b = boxed[j]!
      if (!near(a.box, b.box, reach)) continue
      let best: FitGap | null = null
      for (const pa of a.e.parts) {
        const ba = bounds([pa], a.e.transform)
        for (const pb of b.e.parts) {
          const bb = bounds([pb], b.e.transform)
          if (!ba || !bb || !near(ba, bb, reach)) continue
          const report = await fitCheck([{ mesh: fitMesh(pa), transform: a.e.transform }, { mesh: fitMesh(pb), transform: b.e.transform }], { minGapMm, layerHeightMm }, signal)
          if (signal.aborted) return out
          const g = crossGap(report)
          if (g && (!best || g.gapMm < best.gapMm)) best = g
        }
      }
      if (best) out.push({ ids: [a.e.id, b.e.id], transforms: [a.e.transform, b.e.transform], gapMm: best.gapMm, from: best.from, to: best.to })
    }
  }
  return out
}
