// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The camera guard on the Printers tab: when the hub pauses a print for a hand, or holds a start because something is
// on the plate, the printer's card comes up with the frame and what to do next. The hub decides and keeps the frame
// (packages/connect/link/src/guard.rs); this file keeps the trips, says them in words and wires the actions.
import { useSyncExternalStore } from 'react'
import type { Host } from '@slicerx/contracts'
import { appName } from '../../edition'
import { setWorkspace } from '../../state/store'

/** One trip as the hub sends it (link-client `GuardTrip`). */
export interface GuardTrip {
  printerId: string
  kind?: 'hand' | 'plate'
  state: 'paused' | 'alert' | 'blocked' | 'clear'
  at: string
  box?: [number, number, number, number]
  note?: string
  confidence?: number
  monitorOnly?: boolean
  startedBy?: 'slicerx' | 'printer'
  plateFrom?: string
  capturedAt?: string
  /** The person answered it (dismissed, the plate checked clean, a spot marked fine) while the print stays paused. */
  answered?: boolean
}

/** The hub methods the guard uses (link-client `LinkHost.watch`). */
export interface GuardHub {
  watch: {
    onGuard(cb: (t: GuardTrip) => void): () => void
    guardState(): Promise<{ trips: Record<string, GuardTrip>; off: string[]; plates: Record<string, string>; detector: boolean }>
    evidence(printerId: string, fresh?: boolean): Promise<{ contentType: string; data: Uint8Array; capturedAt: string } | null>
    dismiss(printerId: string, kind: string): Promise<void>
    plateClear(printerId: string): Promise<{ plateFrom: string }>
    plateCheck(printerId: string): Promise<{ checked: boolean; clear?: boolean }>
    plateIgnore(printerId: string): Promise<{ remembered: 'spot' | 'model' | 'nothing' }>
    /** Check again on a hand: a new frame, judged by the detector. `checked` is false without one. */
    handCheck(printerId: string): Promise<{ checked: boolean; hand: boolean | null }>
    /** Resume on the card: the click is the approval for this pause (packages/connect/link/src/guard.rs). */
    resume(printerId: string): Promise<void>
  }
}

/** The printer host as a hub with the guard, or null (a demo, a cloud host, an older hub). */
export function guardHub(host: Host): GuardHub | null {
  const w = (host.printers as Partial<GuardHub> | undefined)?.watch
  return w && typeof w.onGuard === 'function' && typeof w.guardState === 'function' ? (host.printers as unknown as GuardHub) : null
}

// ---- the trips, outside React so the hub's events land whichever page is open ----

let trips: Record<string, GuardTrip> = {}
let plates: Record<string, string> = {}
let focus: string | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}
/** Starts SlicerX held for a dirty plate, by printer: the same start again with "start anyway". */
const held = new Map<string, () => Promise<void>>()

export function guardTrips(): Record<string, GuardTrip> {
  return trips
}

/** Applies one `watch.guard` event. */
export function noteTrip(t: GuardTrip): void {
  if (t.state === 'clear') {
    if (!trips[t.printerId]) return
    const { [t.printerId]: _gone, ...rest } = trips
    trips = rest
    held.delete(t.printerId)
  } else {
    trips = { ...trips, [t.printerId]: t }
  }
  emit()
}

/** When each printer's empty-plate picture was taken. */
export function platesTaken(): Record<string, string> {
  return plates
}

export function notePlate(printerId: string, from: string | null): void {
  const { [printerId]: _old, ...rest } = plates
  plates = from ? { ...rest, [printerId]: from } : rest
  emit()
}

/** The printer whose card should come into view and take focus, once. */
export function takeFocus(printerId: string): boolean {
  if (focus !== printerId) return false
  focus = null
  return true
}

export function useGuard(): { trips: Record<string, GuardTrip>; plates: Record<string, string> } {
  const t = useSyncExternalStore(subscribe, guardTrips)
  const p = useSyncExternalStore(subscribe, platesTaken)
  return { trips: t, plates: p }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** Keeps a start the hub held for the plate, so the card can offer "It's fine, start anyway". */
export function holdStart(printerId: string, again: () => Promise<void>): void {
  held.set(printerId, again)
  emit()
}

export function heldStart(printerId: string): (() => Promise<void>) | null {
  return held.get(printerId) ?? null
}

/** For tests. */
export function resetGuard(): void {
  trips = {}
  plates = {}
  focus = null
  held.clear()
  emit()
}

// ---- words ----

export interface TripCopy {
  title: string
  body: string
  /** Shown as a banner above the body: the guard could not stop the print. */
  cannotStop?: string
  /** A smaller line under the actions. */
  note?: string
}

/** What the card says for a trip. `name` is the printer's name. */
export function tripCopy(t: GuardTrip, name: string): TripCopy {
  const app = appName()
  const bambuConnect = `${app} can't stop this print. Developer Mode is off on ${name}, so the job came from Bambu Connect or the printer's screen.`
  if (t.state === 'paused' && t.answered)
    return {
      title: 'Still paused',
      body:
        t.kind === 'hand'
          ? `You dismissed the hand. The print stays paused until you resume it.`
          : `You checked the plate. The print stays paused until you resume it.`,
    }
  if (t.kind === 'hand') {
    const seen = t.note && /\d+ of the last \d+ frames/.test(t.note) ? `in ${/\d+ of the last \d+ frames/.exec(t.note)![0]}` : 'in the camera'
    if (t.state === 'paused')
      return {
        title: 'Paused: a hand in the printer',
        body: `The watch saw a hand ${seen}, so ${app} paused the print. The head may finish its current move first. Heaters stay on.`,
        note: 'Dismiss raises the bar for hands on this printer until this print ends.',
      }
    return {
      title: 'Hand seen, print still running',
      body: `The watch saw a hand ${seen}. Phones paired with ${app} get an alert too. Stop the print on the printer if you need to.`,
      cannotStop: t.monitorOnly ? bambuConnect : `${app} tried to pause ${name}, but the printer did not take the command.`,
    }
  }
  const from = t.plateFrom ? ` from ${shortTime(t.plateFrom)}` : ''
  const against = t.plateFrom ? `It doesn't match your empty-plate picture${from}.` : `There's no empty-plate picture for ${name} yet, so only the camera model looked.`
  const where = t.box ? ' The spot is marked on the picture.' : ''
  if (t.state === 'blocked')
    return {
      title: 'Something on the plate',
      body: `${app} held the start. ${against}${where}`,
      note: t.box
        ? "\"It's fine\" skips this spot on this printer from now on. \"This plate is clear\" takes a new empty-plate picture once you've cleared it."
        : "\"It's fine\" stops the camera model alone from holding starts on this printer. \"This plate is clear\" takes an empty-plate picture once you've cleared it.",
    }
  if (t.state === 'paused')
    return {
      title: 'Paused: something on the plate',
      body: `This print started on the printer, and ${app} paused it before it got going. ${against}${where}`,
      ...(t.box ? { note: "\"It's fine\" skips this spot on this printer from now on and resumes." } : {}),
    }
  return {
    title: 'Something on the plate',
    body: `${against}${where} Clear the plate before you press Print next time.`,
    cannotStop: t.monitorOnly ? bambuConnect : `${app} tried to pause ${name}, but the printer did not take the command.`,
  }
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** The phone and desktop notification text: short, names the printer. */
export function notifyText(t: GuardTrip, name: string): { title: string; body: string } {
  if (t.kind === 'hand') return { title: t.state === 'paused' ? `${name} paused: a hand in the printer` : `Hand seen in ${name}`, body: t.state === 'paused' ? 'Open Printers to resume.' : 'The print is still running.' }
  return { title: t.state === 'blocked' ? `${name}: something on the plate` : t.state === 'paused' ? `${name} paused: something on the plate` : `${name}: something on the plate`, body: t.state === 'blocked' ? 'The start is on hold.' : t.state === 'paused' ? 'Open Printers to check it.' : 'The print is still running.' }
}

// ---- wiring ----

/** An OS notification when the person allowed them; nothing otherwise. */
function osNotify(title: string, body: string): void {
  const N = (globalThis as { Notification?: typeof Notification }).Notification
  if (!N || N.permission !== 'granted') return
  try {
    new N(title, { body })
  } catch {
    // some webviews expose the constructor but refuse it
  }
}

/** Asks once for OS notifications, from a click (browsers allow the question only then). */
export function askToNotify(): void {
  const N = (globalThis as { Notification?: typeof Notification }).Notification
  if (N && N.permission === 'default') void N.requestPermission().catch(() => undefined)
}

/** A printer's name as the host lists it, or its id. */
async function nameOf(host: Host, printerId: string): Promise<string> {
  const list = await host.printers?.list().catch(() => [])
  return list?.find((p) => p.id === printerId)?.name ?? printerId
}

/**
 * Follows the hub's guard for the life of a bridge connection: the trips it already has, then each new one, which
 * brings up the Printers tab with that printer's card in focus and an OS notification.
 */
export function watchGuard(host: Host): () => void {
  const hub = guardHub(host)
  if (!hub) return () => undefined
  let live = true
  void hub.watch
    .guardState()
    .then((s) => {
      if (!live) return
      // An event that came in while this was on the way is newer.
      trips = { ...s.trips, ...trips }
      plates = { ...s.plates, ...plates }
      emit()
    })
    .catch(() => undefined)
  const off = hub.watch.onGuard((t) => {
    noteTrip(t)
    if (t.state === 'clear') return
    focus = t.printerId
    setWorkspace('printers')
    emit()
    void nameOf(host, t.printerId).then((name) => {
      const n = notifyText(t, name)
      osNotify(n.title, n.body)
    })
  })
  return () => {
    live = false
    off()
    trips = {}
    plates = {}
    held.clear()
    emit()
  }
}
