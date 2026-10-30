// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's plate check before a slice, where the host has an engine (the desktop): after an edit to a by-object plate
// the app asks the engine what a slice would be refused for, from the objects' footprints. The footprint rule of
// sequence-check.ts stays on screen until the answer lands, follows a drag on its own, and is all the web and the phone
// have. The check runs off the page's thread (SlicerHost.checkPlate), starts a short pause after the edit, never
// while a drag edits the plate, and a newer edit cancels an older run, whose answer is let go.
import type { CollisionFix, Host, PlateCheck, SliceRequest, SlicerHost, UncheckedKind } from '@slicerx/contracts'
import { knownUnchecked } from '@slicerx/contracts'
import { INPUTS, inputsChanged } from '../state/slice-inputs'
import { appStore, get, set, type AppState, type PlateCheckState } from '../state/store'
import { activeClearance, sequenceProblem } from './sequence-check'

/** The pause after an edit before the check starts, ms. Edits arrive whole (a drop, a typed value, a nudge). */
export const CHECK_DELAY_MS = 250
/** How long a check runs before the warning says it is checking, ms. */
export const CHECK_SLOW_MS = 300
/** How many answers are kept by request, so an undo or a redo has its answer at once. */
const KEPT = 16

/** The slice inputs an answer is for, by reference. */
export type CheckInputs = PlateCheckState['inputs']

const inputsOf = (s: AppState): NonNullable<CheckInputs> => Object.fromEntries(INPUTS.map((k) => [k, s[k]])) as NonNullable<CheckInputs>

/**
 * The engine's answer for the plate as it is now, or null: none yet, one for an earlier edit, or none to give (a host
 * without the check, a plate by layer). A newer answer than the last edit replaces the footprint rule's verdict.
 */
export function engineVerdict(s: Partial<Pick<AppState, 'plateCheck'>> & Partial<AppState>): PlateCheck | null {
  const c = s.plateCheck
  if (!c || c.status !== 'done' || !c.result || !c.inputs) return null
  return inputsChanged(s as AppState, c.inputs as unknown as AppState) ? null : c.result
}

/**
 * Why a by-object plate may collide as it sits, as one message, or null: the footprint rule's words until the engine
 * has answered for the plate as it sits, and then nothing, since the engine's answer holds nothing back (the warning
 * shows it, and the slice decides).
 */
export function preflightProblem(s: Parameters<typeof sequenceProblem>[0] & Partial<Pick<AppState, 'plateCheck'>>): string | null {
  return engineVerdict(s) ? null : sequenceProblem(s)
}

/** The check for the plate now is running and has taken longer than CHECK_SLOW_MS. */
export const checkingSlowly = (s: Pick<AppState, 'plateCheck'>): boolean => s.plateCheck.status === 'running' && s.plateCheck.slow

/** Two objects the check found a strike between, and the collisions (indices) that name them. */
export interface CheckPair {
  a: string
  b: string
  collisions: number[]
}

/** What the warning shows of an answer. */
export interface CheckRows {
  /** Pairs with a strike the slice is sure to refuse, then pairs where only the slice can tell. */
  sure: CheckPair[]
  decides: CheckPair[]
  /** Kinds the check left to the slice where another object is close enough for them to matter, each once. */
  unchecked: UncheckedKind[]
}

/**
 * The answer as rows. A close call (inside the profile's radius where the head's measured shape clears) shows nothing:
 * the slice prints it. A pair with a sure strike is not listed again among those the slice decides.
 */
export function checkRows(check: PlateCheck): CheckRows {
  const sure = new Map<string, CheckPair>()
  const decides = new Map<string, CheckPair>()
  check.collisions.forEach((c, i) => {
    if (c.severity !== 'hit') return
    const [a, b] = c.objectId < c.hitId ? [c.objectId, c.hitId] : [c.hitId, c.objectId]
    const into = check.certainty[i] === 'sure' ? sure : decides
    const key = `${a}\n${b}`
    const pair = into.get(key) ?? { a: c.hitId, b: c.objectId, collisions: [] }
    pair.collisions.push(i)
    into.set(key, pair)
  })
  for (const key of sure.keys()) decides.delete(key)
  const unchecked = [...new Set(check.unchecked.filter((u) => u.near.length > 0).map((u) => u.what))].filter(knownUnchecked)
  return { sure: [...sure.values()], decides: [...decides.values()], unchecked }
}

/**
 * The one-click fixes the warning offers for the sure strikes: a new print order that clears one of them, and print by
 * layer when it clears every one.
 */
export function checkFixes(check: PlateCheck): CollisionFix[] {
  const sure = check.collisions.flatMap((c, i) => (c.severity === 'hit' && check.certainty[i] === 'sure' ? [i] : []))
  if (sure.length === 0) return []
  const reorder = check.collisionFixes.find((f) => f.kind === 'reorder' && f.oneClick && (f.order?.length ?? 0) > 0 && f.clears.some((i) => sure.includes(i)))
  const byLayer = check.collisionFixes.find((f) => f.kind === 'by_layer' && f.oneClick && sure.every((i) => f.clears.includes(i)))
  return [reorder, byLayer].filter((f): f is CollisionFix => f !== undefined)
}

/** Whether the plate in `s` is one the engine checks: by object with two or more printable objects, not mid-edit. */
function wanted(s: AppState): boolean {
  return !s.plateLoading && !s.historyEdit && activeClearance(s) !== null
}

/** The request the check sends: the slice's own plate, settings and options, with no G-code or preview to make. */
async function checkRequest(slicer: SlicerHost, s: AppState): Promise<SliceRequest> {
  const { plateObjects, plateSliceConfig } = await import('../state/slice-plate')
  const meta = s.plates.find((p) => p.id === s.activePlate)
  const config = plateSliceConfig(s, meta)
  const objects = await plateObjects(slicer, s, meta, s.plate)
  const toPrint = s.plate.filter((p) => p.printable !== false)
  const { heightRangesOf } = await import('./layer-ranges')
  const heightRanges = [...(s.calibration[s.activePlate]?.ranges ?? []), ...heightRangesOf(toPrint, { layerHeights: !s.calibration[s.activePlate] })]
  const marks = s.layerMarks[s.activePlate] ?? []
  const toolChanges = marks.length ? (await import('./layer-marks')).toolChangesByHeight(marks) : []
  return {
    plate: { bed: s.bed, objects },
    config,
    options: { emitGcode: false, emitPreview: false, ...(s.profile?.printerId ? { printerId: s.profile.printerId } : {}), ...(heightRanges.length ? { heightRanges } : {}), ...(toolChanges.length ? { toolChanges } : {}) },
  }
}

const IDLE: PlateCheckState = { status: 'idle', id: 0, inputs: null, result: null, slow: false }

let now: (() => Promise<PlateCheck | null>) | null = null

/**
 * Checks the plate as it is now, at once, and answers with the result: null when the host has no check, the plate is
 * not one it checks, or a newer edit took over. Arrange asks for this after it lays the plate out.
 */
export function checkNow(): Promise<PlateCheck | null> {
  return now ? now() : Promise.resolve(null)
}

/** Starts checking after edits. Returns the stop function; a host without the check gets one that does nothing. */
export function startEngineCheck(host: Pick<Host, 'slicer'>, delayMs = CHECK_DELAY_MS): () => void {
  const slicer = host.slicer
  if (!slicer.checkPlate) return () => undefined
  const ask = slicer.checkPlate.bind(slicer)
  const kept = new Map<string, PlateCheck>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let slowTimer: ReturnType<typeof setTimeout> | null = null
  let running: AbortController | null = null
  let seq = 0

  /** A newer edit cancels the run in flight: its answer is let go, and the engine skips it if it has not started. */
  const cancel = (): void => {
    running?.abort()
    running = null
    if (slowTimer) clearTimeout(slowTimer)
    slowTimer = null
  }
  const run = async (): Promise<PlateCheck | null> => {
    timer = null
    cancel()
    const s = get()
    if (!wanted(s)) {
      if (s.plateCheck.status !== 'idle') set({ plateCheck: IDLE })
      return null
    }
    const id = ++seq
    const ac = new AbortController()
    running = ac
    const inputs = inputsOf(s)
    set({ plateCheck: { status: 'running', id, inputs, result: s.plateCheck.result, slow: false } })
    slowTimer = setTimeout(() => {
      const c = get().plateCheck
      if (c.id === id && c.status === 'running') set({ plateCheck: { ...c, slow: true } })
    }, CHECK_SLOW_MS)
    try {
      const req = await checkRequest(slicer, s)
      if (ac.signal.aborted) return null
      const key = JSON.stringify(req)
      let result = kept.get(key)
      if (!result) {
        result = await ask(req, { signal: ac.signal })
        kept.set(key, result)
        if (kept.size > KEPT) kept.delete(kept.keys().next().value!)
      }
      if (ac.signal.aborted || get().plateCheck.id !== id) return null
      set({ plateCheck: { status: 'done', id, inputs, result, slow: false } })
      return result
    } catch {
      // A failed check leaves the footprint rule on screen; the slice still decides.
      if (!ac.signal.aborted && get().plateCheck.id === id) set({ plateCheck: { status: 'error', id, inputs, result: null, slow: false } })
      return null
    } finally {
      if (running === ac) {
        running = null
        if (slowTimer) clearTimeout(slowTimer)
        slowTimer = null
      }
    }
  }
  const schedule = (s: AppState): void => {
    if (timer) clearTimeout(timer)
    timer = null
    cancel()
    if (!wanted(s)) {
      if (s.plateCheck.status !== 'idle') set({ plateCheck: IDLE })
      return
    }
    // A drag that edits the plate on every move checks once, on release.
    if (s.liveEdit) return
    timer = setTimeout(() => void run(), delayMs)
  }
  const unsubscribe = appStore.subscribe((s, prev) => {
    const released = prev.liveEdit && !s.liveEdit
    const loaded = (prev.plateLoading && !s.plateLoading) || (prev.historyEdit !== null && s.historyEdit === null)
    if (!released && !loaded && !inputsChanged(s, prev)) return
    schedule(s)
  })
  now = () => {
    if (timer) clearTimeout(timer)
    return run()
  }
  schedule(get())
  return () => {
    if (timer) clearTimeout(timer)
    cancel()
    unsubscribe()
    now = null
    set({ plateCheck: IDLE })
  }
}
