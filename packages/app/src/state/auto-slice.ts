// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Background slicing. When Auto slice is on, any edit that changes the print starts a new slice after a short pause; set
// to Auto (by size, the default) a plate whose slice is expected to be big waits for Slice instead (auto-slice-mode.ts). A slice
// still running for an older edit is canceled the moment the newer edit lands, and a finished slice is marked stale at once, so
// the numbers and the preview never pass for the current plate. A drag that edits on every move (a scrub, a slider) slices
// once, on release. An opened project and the example plate at launch wait for Slice instead.
import type { Host } from '@slicerx/contracts'
import { cancelSlice, currentSlice, slicePlate, STALE_SLICE } from './actions'
import { fitSettledFor, onFitSettled } from '../plate/fit-state'
import { isBigSlice, sliceTimingsOf } from './slice-estimate'
import { flushRefreshOnly, inputsChanged as changed, KEY_CONFIG } from './slice-inputs'
import { appStore, type AppState } from './store'

export { INPUTS } from './slice-inputs'

/**
 * The pause after an edit before the slice starts. Edits arrive whole (a typed value on Enter, a click, a drag on
 * release), so this only gathers ones that land together, such as a tile that sets several values.
 */
export const AUTO_SLICE_DELAY_MS = 150

/**
 * The longest a big slice waits for the plate's fit check (ms): a check that never reports (its watch not mounted, say)
 * does not hold the slice back for good.
 */
export const FIT_WAIT_MS = 15_000

/**
 * How long an agent's run of edits (mimir's tools, a client on the app link) is quiet before it counts as ended (ms).
 * Auto slice holds from an agent's first call until no agent call has run for this long, then slices once.
 */
export const AGENT_QUIET_MS = 3000

// Agent calls running now, the timer that ends the hold once they have been quiet for AGENT_QUIET_MS, and what the
// running watch does then.
let agentCalls = 0
let agentQuiet: ReturnType<typeof setTimeout> | null = null
let agentRunEnded: (() => void) | null = null

/** Whether an agent's run of edits holds auto slice: a call of it running, or less than AGENT_QUIET_MS since the last. */
export const agentHolds = (): boolean => agentCalls > 0 || agentQuiet !== null

/**
 * Runs one call of an agent (a mimir tool, an app link edit) under the hold: auto slice starts no slice while the run
 * goes on, and slices once when it ends, as for a step open for editing.
 */
export async function agentCall<T>(call: () => Promise<T>): Promise<T> {
  agentCalls++
  if (agentQuiet) clearTimeout(agentQuiet)
  agentQuiet = null
  try {
    return await call()
  } finally {
    if (--agentCalls === 0) {
      agentQuiet = setTimeout(() => {
        agentQuiet = null
        agentRunEnded?.()
      }, AGENT_QUIET_MS)
    }
  }
}

/** Whether the running watch has a slice about to start: its pause after an edit, or a big slice's wait for the fit check. */
let pending: () => boolean = () => false

/** Whether auto slice has a slice about to start (its pause after an edit, or a big slice waiting on the fit check). */
export const autoSlicePending = (): boolean => pending()

/** Starts watching the store. Returns the stop function. */
export function startAutoSlice(host: Host, delayMs = AUTO_SLICE_DELAY_MS, fitWaitMs = FIT_WAIT_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiting: (() => void) | null = null
  // The run of the slice it has started that is not running yet (it waits on the profile first), 0 for none: set until
  // that run's slice runs or gives up. Each run has its own number, so a canceled run that ends late, or still shows
  // as running, never clears a newer run's start.
  let starting = 0
  let runs = 0
  // The abort controller of the last slice auto slice started. Only while it is still the running slice is that slice
  // stopped for a new nozzle volume (configMoved): one canceled and still unwinding, or finished, is not, so a slice
  // someone starts after it is never stopped.
  let autoAbort: AbortController | null = null
  // A slice someone asked for was running when the nozzle volume changed: once it lands, it is checked against the
  // new value and sliced again when it read the old one.
  let checkLanded = false
  // An agent's run held a slice back: it goes when the run ends.
  let heldForAgent = false
  const isPending = (): boolean => timer !== null || waiting !== null || starting !== 0 || heldForAgent
  pending = isPending
  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    waiting?.()
    waiting = null
  }
  /** `force`: the wait for the fit check ran out, so a big slice goes anyway. */
  const run = (force = false): void => {
    timer = null
    const s = appStore.getState()
    if (s.plate.length === 0 && s.sliceHeld) appStore.setState({ sliceHeld: false })
    // A step open for editing rolls the part back; the slice waits for the edit to end.
    // An open that starts a project ends on Slice plate (AppState.revealHold), as does the example plate at launch
    // (AppState.exampleSeeding): each slices on a click or a later edit.
    if (!s.autoSlice || s.plate.length === 0 || s.revealHold || s.exampleSeeding || (s.plateLoading && !s.sliceDuringOpen) || s.historyEdit) return
    // An agent's run of edits slices once, when it ends (agentCall).
    if (agentHolds()) {
      heldForAgent = true
      return
    }
    // A plate switched back to with its slice still current (workspaces/preview/plate-slices.ts) needs none.
    if (s.slice.status === 'done' && !s.slice.stale) return
    // Auto by size: a big slice waits for Slice, and the footer says so.
    const big = isBigSlice(s.plate, sliceTimingsOf(s.activePlate))
    if (s.autoSliceBySize && big) {
      if (!s.sliceHeld || s.heldByOpenedProject) appStore.setState({ sliceHeld: true, heldByOpenedProject: false })
      return
    }
    if (s.sliceHeld) appStore.setState({ sliceHeld: false })
    // A big slice waits for the plate's fit check, so its copy of the meshes and the fit check's are not alive at once
    // (slice-estimate.ts); a small one goes now.
    if (!force && !s.plateLoading && !fitSettledFor(s.plate) && big) {
      const go = (late: boolean): void => {
        clear()
        timer = setTimeout(() => run(late), 0)
      }
      const off = onFitSettled(() => fitSettledFor(appStore.getState().plate) && go(false))
      const late = setTimeout(() => go(true), fitWaitMs)
      waiting = () => {
        off()
        clearTimeout(late)
      }
      return
    }
    waiting?.()
    waiting = null
    const mine = ++runs
    starting = mine
    // A slice that runs from now on is this run's: one still running from before (canceled, not yet unwound) keeps
    // the start it had.
    const before = appStore.getState().slice
    const was = before.status === 'running' ? before.startedAt : null
    const off = appStore.subscribe((now) => {
      if (now.slice.status === 'running' && now.slice.startedAt !== was) settle()
    })
    const settle = (): void => {
      if (starting === mine) starting = 0
      off()
    }
    void slicePlate(host, { auto: true, onBegin: (abort) => (autoAbort = abort) }).then(settle, settle)
  }
  const configMoved = async (now: AppState, prev: AppState): Promise<void> => {
    const { configKey, stampBlock } = await import('../plate/resume-tops')
    const s = appStore.getState()
    if (!s.autoSlice || s.liveEdit) return
    if (s.slice.status === 'running') {
      // An auto slice in flight read the old values: it would land stale with nothing to slice again, so it stops and a
      // new one starts. Only a change the plate's configuration reads (a single-color plate has no flush volumes). A
      // slice someone asked for (Slice, mimir, the print queue) is theirs: it lands, and is checked once it has.
      if (configKey(now) === configKey(prev)) return
      if (!autoAbort || !currentSlice(autoAbort)) {
        checkLanded = true
        return
      }
      cancelSlice({ quiet: true })
    } else {
      if (s.slice.status !== 'done' || s.slice.stale || stampBlock(s, s.slice.stamp) !== STALE_SLICE) return
      appStore.setState({ slice: { ...s.slice, stale: true } })
    }
    clear()
    timer = setTimeout(() => run(), delayMs)
  }
  agentRunEnded = () => {
    if (!heldForAgent) return
    heldForAgent = false
    clear()
    timer = setTimeout(() => run(), 0)
  }
  const unsubscribe = appStore.subscribe((s, prev) => {
    if (!s.autoSlice) {
      checkLanded = false
      heldForAgent = false
      if (s.sliceHeld) appStore.setState({ sliceHeld: false })
      return clear()
    }
    // The slice someone asked for has landed: stale and sliced again when it read the old nozzle volume.
    if (checkLanded && prev.slice.status === 'running' && s.slice.status !== 'running') {
      checkLanded = false
      if (s.slice.status === 'done') void configMoved(s, prev)
    }
    // The end of an open that started a project slices nothing, whatever the plate's size: a wait set during it goes,
    // and Slice is the action until the person presses it or edits the plate (the edit slices as the setting says).
    // The example plate a session starts with ends the same way.
    if ((prev.revealHold && !s.revealHold) || (prev.exampleSeeding && !s.exampleSeeding)) {
      clear()
      if (s.plate.length > 0 && !s.sliceHeld) appStore.setState({ sliceHeld: true, heldByOpenedProject: prev.revealHold })
      return
    }
    // Turning it on, or from Auto to Always, slices what is there now.
    const turnedOn = !prev.autoSlice || (prev.autoSliceBySize && !s.autoSliceBySize)
    const released = prev.liveEdit && !s.liveEdit
    const loaded = prev.plateLoading && !s.plateLoading
    // The measured flush tables land a moment after the first flush calculation (the footer's sleipnir line makes one
    // as soon as the plate is in) and rewrite the flush settings unchanged. A slice done or running read the old
    // values and goes again; with none yet there is nothing to redo, and a plate waiting for Slice keeps waiting.
    if (!turnedOn && !released && !loaded && flushRefreshOnly(s, prev) && s.slice.status !== 'done' && s.slice.status !== 'running') return
    if (!turnedOn && !released && !changed(s, prev) && !loaded) {
      // A KEY_CONFIG value (a new printer's nozzle volume, an opened project's flush matrix) is not a slice input, but a
      // finished slice whose configuration read it is stale (resume-tops.ts stampBlock): mark it and slice again. The
      // stamp check loads with the slice code, so the shell does not carry it.
      if (KEY_CONFIG.some((k) => s[k] !== prev[k])) void configMoved(s, prev)
      return
    }
    // An open whose model sliced while it loaded and did not change since: that slice, running or done, is the one.
    if (loaded && prev.sliceDuringOpen && !turnedOn && !released && !changed(s, prev) && (s.slice.status === 'running' || (s.slice.status === 'done' && !s.slice.stale))) return
    if (s.slice.status === 'running') cancelSlice({ quiet: true })
    if (s.slice.status === 'done' && !s.slice.stale) appStore.setState({ slice: { ...s.slice, stale: true } })
    clear()
    // Mid-drag the slice would be thrown away on the next move; the release starts it.
    if (s.liveEdit) return
    timer = setTimeout(() => run(), delayMs)
  })
  return () => {
    clear()
    unsubscribe()
    heldForAgent = false
    agentRunEnded = null
    if (pending === isPending) pending = () => false
  }
}
