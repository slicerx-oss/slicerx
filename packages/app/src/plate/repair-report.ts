// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a mesh repair changed, in plain words: the counts sx-geom's repair returns, summed over the parts of
// an object, a headline for the toast and the lines for the details dialog. Nothing here is estimated;
// a count the engine did not send is left out.
import { useSyncExternalStore } from 'react'

export interface RepairCounts {
  verticesMerged?: number
  degenerateRemoved?: number
  duplicatesRemoved?: number
  trianglesFlipped?: number
  holesFilled?: number
  holesLeftOpen?: number
  nonManifoldEdges?: number
  boundaryEdgesAfter?: number
  selfIntersectionsFixed?: number
  selfIntersectingLeft?: number
  watertight?: boolean
}

export interface RepairEntry {
  /** The object or part the numbers belong to. */
  label: string
  report: RepairCounts
}

const SUMMED = ['verticesMerged', 'degenerateRemoved', 'duplicatesRemoved', 'trianglesFlipped', 'holesFilled', 'holesLeftOpen', 'nonManifoldEdges', 'boundaryEdgesAfter', 'selfIntersectionsFixed', 'selfIntersectingLeft'] as const

export function sumRepair(reports: readonly RepairCounts[]): RepairCounts {
  const out: RepairCounts = {}
  for (const key of SUMMED) {
    const seen = reports.filter((r) => typeof r[key] === 'number')
    if (seen.length) out[key] = seen.reduce((n, r) => n + (r[key] ?? 0), 0)
  }
  const marks = reports.filter((r) => typeof r.watertight === 'boolean')
  if (marks.length) out.watertight = marks.every((r) => r.watertight)
  return out
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** One plain sentence per thing that was fixed, then one per problem that is still there. Empty when nothing changed. */
export function repairLines(r: RepairCounts): string[] {
  const out: string[] = []
  const add = (n: number | undefined, text: (n: number) => string) => {
    if (n && n > 0) out.push(text(n))
  }
  add(r.holesFilled, (n) => `${plural(n, 'hole', 'holes')} closed`)
  add(r.trianglesFlipped, (n) => `${plural(n, 'face', 'faces')} flipped to point outward`)
  add(r.duplicatesRemoved, (n) => `${plural(n, 'duplicate face', 'duplicate faces')} removed`)
  add(r.degenerateRemoved, (n) => `${plural(n, 'zero-area face', 'zero-area faces')} removed`)
  add(r.verticesMerged, (n) => `${plural(n, 'vertex', 'vertices')} merged`)
  add(r.selfIntersectionsFixed, (n) => `${plural(n, 'self-intersection', 'self-intersections')} rebuilt`)
  add(r.holesLeftOpen, (n) => `${plural(n, 'hole', 'holes')} too big to close, still open`)
  add(r.nonManifoldEdges, (n) => `${plural(n, 'edge', 'edges')} shared by more than two faces, left as is`)
  add(r.selfIntersectingLeft, (n) => `${plural(n, 'self-intersection', 'self-intersections')} left`)
  return out
}

/** The fixes only (what changed), for deciding whether there is anything to report. */
export function repairChanged(r: RepairCounts): boolean {
  return Boolean(r.holesFilled || r.trianglesFlipped || r.duplicatesRemoved || r.degenerateRemoved || r.verticesMerged || r.selfIntersectionsFixed)
}

export function repairHeadline(r: RepairCounts): string {
  const open = (r.holesLeftOpen ?? 0) + (r.nonManifoldEdges ?? 0) + (r.selfIntersectingLeft ?? 0)
  if (!repairChanged(r)) return open ? 'Nothing could be fixed automatically.' : 'The mesh was already clean.'
  const lines = repairLines(r).filter((l) => !/still open|left/.test(l))
  const head = `Repaired: ${lines.slice(0, 3).join(', ')}${lines.length > 3 ? ` and ${lines.length - 3} more` : ''}.`
  return open ? `${head} Some problems remain.` : head
}

export interface RepairReportView {
  title: string
  entries: RepairEntry[]
}

let current: RepairReportView | null = null
let last: RepairReportView | null = null
const listeners = new Set<() => void>()

function write(v: RepairReportView | null): void {
  current = v
  if (v) last = v
  for (const l of listeners) l()
}

/** Opens the details dialog on this report. */
export const showRepairReport = (view: RepairReportView): void => write(view)
/** Keeps a report for the command without opening it. */
export const rememberRepair = (view: RepairReportView): void => {
  last = view
}
export const closeRepairReport = (): void => write(null)
/** Opens the report of the most recent repair, or returns false when there has not been one. */
export function showLastRepair(): boolean {
  if (!last) return false
  write(last)
  return true
}
export const lastRepairForTest = (): RepairReportView | null => last

export function useRepairReport(): RepairReportView | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
    () => null,
  )
}
