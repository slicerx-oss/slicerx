// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Autosave and recent projects. A few seconds after the plates change, the project is written as .sx3mf to
// this device's storage. It stays there until the project is saved or the plates are emptied, so work is
// offered back after a crash or a closed tab. Saved and opened projects are kept as recent projects. While a
// locked project is open the autosave is sealed with that file's key (project/locked-session.ts), and no copy
// of it is kept in the clear.
import type { Host } from '@slicerx/contracts'
import { allPlates } from '../plate/plates'
import { lockedSession, setLockedSession } from './locked-session'
import { confirmDiscard } from './unsaved'
import { appStore, get, set, type AppState } from '../state/store'

export const AUTOSAVE_DELAY_MS = 4000
export const MAX_RECENT = 6
/** Bigger projects are not copied into storage. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
export const AUTOSAVE_ID = 'autosave'

export interface Snapshot {
  id: string
  name: string
  savedAt: number
  objects: number
  data: Uint8Array
  /** A locked project's autosave: .sxlock bytes, opened with the account like the file itself. */
  locked?: boolean
}

export interface SnapshotStore {
  list(): Promise<Snapshot[]>
  put(s: Snapshot): Promise<void>
  remove(id: string): Promise<void>
}

const DB = 'slicerx-projects'
const TABLE = 'snapshots'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(TABLE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Could not open project storage'))
  })
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(TABLE, mode)
        const req = fn(tx.objectStore(TABLE))
        tx.oncomplete = () => {
          db.close()
          resolve(req.result)
        }
        tx.onerror = () => reject(tx.error ?? new Error('Project storage failed'))
      }),
  )
}

export function indexedDbSnapshots(): SnapshotStore {
  return {
    list: () => run('readonly', (s) => s.getAll() as IDBRequest<Snapshot[]>),
    put: (x) => run('readwrite', (s) => s.put(x)).then(() => undefined),
    remove: (id) => run('readwrite', (s) => s.delete(id)).then(() => undefined),
  }
}

export function memorySnapshots(): SnapshotStore {
  const rows = new Map<string, Snapshot>()
  return {
    list: async () => [...rows.values()],
    put: async (x) => void rows.set(x.id, x),
    remove: async (id) => void rows.delete(id),
  }
}

let current: SnapshotStore | null = null
export function setSnapshotStore(s: SnapshotStore | null): void {
  current = s
}
export function snapshotStore(): SnapshotStore {
  return (current ??= typeof indexedDB === 'undefined' ? memorySnapshots() : indexedDbSnapshots())
}

const objectCount = (): number => allPlates(get()).reduce((n, p) => n + p.objects.length, 0)

/** Names the project after its first object, as Save does. */
function projectName(): string {
  const first = allPlates(get()).flatMap((p) => p.objects)[0]?.name ?? 'project'
  return `${first.replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '_') || 'project'}.sx3mf`
}

/** What an autosave reads: every project input except slicing state. */
const INPUTS = ['plate', 'plates', 'activePlate', 'overrides', 'easy', 'objectSettings', 'slotSetup', 'layerMarks', 'bed'] as const satisfies readonly (keyof AppState)[]

/** Writes the project now, or clears the autosave when the plates are empty. */
export async function autosaveNow(): Promise<boolean> {
  const n = objectCount()
  if (n === 0) {
    setLockedSession(null)
    await snapshotStore().remove(AUTOSAVE_ID)
    return false
  }
  const { sx3mfBytes } = await import('../export/actions')
  const plain = await sx3mfBytes(allPlates(get()))
  if (plain.byteLength > MAX_SNAPSHOT_BYTES) return false
  const key = lockedSession()
  if (key) {
    const { resealSxlock } = await import('@slicerx/embed/sxlock')
    const data = await resealSxlock(plain, key)
    await snapshotStore().put({ id: AUTOSAVE_ID, name: projectName().replace(/\.sx3mf$/, '.sxlock'), savedAt: Date.now(), objects: n, data, locked: true })
    return true
  }
  await snapshotStore().put({ id: AUTOSAVE_ID, name: projectName(), savedAt: Date.now(), objects: n, data: plain })
  return true
}

/** Watches the store and autosaves a few seconds after the last change. Returns the stop function. */
export function startAutosave(delayMs = AUTOSAVE_DELAY_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    timer = null
    if (appStore.getState().plateLoading) return void (timer = setTimeout(fire, delayMs))
    void autosaveNow().catch(() => undefined)
  }
  const unsubscribe = appStore.subscribe((s, prev) => {
    if (!INPUTS.some((k) => s[k] !== prev[k])) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, delayMs)
  })
  return () => {
    if (timer) clearTimeout(timer)
    unsubscribe()
  }
}

/** The autosave left from an earlier session, when there is work in it. */
export async function findRecovery(): Promise<Snapshot | null> {
  const rows = await snapshotStore().list().catch(() => [] as Snapshot[])
  return rows.find((r) => r.id === AUTOSAVE_ID && r.objects > 0) ?? null
}

/** Recent projects, newest first. */
export async function listRecent(): Promise<Snapshot[]> {
  const rows = await snapshotStore().list().catch(() => [] as Snapshot[])
  return rows.filter((r) => r.id !== AUTOSAVE_ID).sort((a, b) => b.savedAt - a.savedAt)
}

/** Remembers a saved or opened project, replacing an earlier one of the same name, and keeps the newest few. */
export async function recordRecent(name: string, data: ArrayBuffer | Uint8Array, objects = objectCount()): Promise<void> {
  // A locked project's content is never stored in the clear.
  if (lockedSession()) return
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) return
  try {
    const store = snapshotStore()
    await store.put({ id: `recent:${name.toLowerCase()}`, name, savedAt: Date.now(), objects, data: bytes })
    for (const old of (await listRecent()).slice(MAX_RECENT)) await store.remove(old.id)
  } catch {
    // Storage can be full or blocked; recent projects are a convenience.
  }
}

/** A project was saved: the autosave is no longer the only copy. */
export async function projectSaved(name: string, data: Uint8Array): Promise<void> {
  await snapshotStore().remove(AUTOSAVE_ID).catch(() => undefined)
  await recordRecent(name, data)
}

export async function discardRecovery(): Promise<void> {
  await snapshotStore().remove(AUTOSAVE_ID).catch(() => undefined)
}

/** Opens a stored project onto the plates. */
export async function openSnapshot(host: Host, snap: Snapshot): Promise<void> {
  const buf = snap.data.buffer.slice(snap.data.byteOffset, snap.data.byteOffset + snap.data.byteLength) as ArrayBuffer
  // A locked autosave opens with the account first; refused (signed out, offline), it stays for later.
  const opened = snap.locked ? await (await import('../export/locked')).unlockBytes(host, snap.name, buf) : { name: snap.name, data: buf }
  if (!opened) return
  if (!(await confirmDiscard('open another project'))) return
  const { openModelBytes } = await import('../state/actions')
  await openModelBytes(host, opened.name, opened.data, undefined, { fresh: true })
  set({ projectsDialog: null })
}
