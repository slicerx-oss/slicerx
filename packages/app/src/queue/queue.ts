// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print queue: plates uploaded to a printer and waiting for a start, each with an optional "not before"
// time. Nothing here starts a print. A due item asks the person, and every start goes through the approval
// card with the bed-clear question (docs/safety.md). Only the printer file reference is kept, never the G-code.
import type { RemoteFile } from '@slicerx/contracts'
import type { SendOptions } from '../send/options'
import { get, set } from '../state/store'

export interface QueueItem {
  id: string
  printerId: string
  printerName: string
  plateName: string
  /** The file as the printer knows it. */
  remote: RemoteFile
  sha256: string
  layers: number
  timeS: number
  grams: number
  options: SendOptions
  /** ISO time; absent means whenever the person starts it. */
  startAfter?: string
  addedAt: string
}

export const QUEUE_LIMIT = 200

let seq = 0
export const queueId = (): string => `q_${Date.now().toString(36)}${(++seq).toString(36)}`

export function addToQueue(item: QueueItem): void {
  set((s) => ({ queue: [...s.queue, item].slice(-QUEUE_LIMIT) }))
}

export function removeFromQueue(id: string): void {
  set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }))
}

/** True once an item's time has come. An item without a time is never "due"; the person starts it. */
export function isDue(item: Pick<QueueItem, 'startAfter'>, now: number = Date.now()): boolean {
  if (!item.startAfter) return false
  const t = Date.parse(item.startAfter)
  return Number.isFinite(t) && t <= now
}

export function dueItems(queue: readonly QueueItem[], now: number = Date.now()): QueueItem[] {
  return queue.filter((q) => isDue(q, now))
}

/**
 * Within one printer the queue runs in order: an item can start when nothing ahead of it on the same printer is still
 * waiting. Returns the ids that may start now.
 */
export function startable(queue: readonly QueueItem[]): Set<string> {
  const seen = new Set<string>()
  const out = new Set<string>()
  for (const q of queue) {
    if (!seen.has(q.printerId)) out.add(q.id)
    seen.add(q.printerId)
  }
  return out
}

/** "Not before" for a <input type="datetime-local"> value (local time, no zone) to an ISO string, or undefined when empty or invalid. */
export function startAfterFromLocal(value: string): string | undefined {
  if (!value) return undefined
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

export function queueFor(printerId?: string): QueueItem[] {
  const q = get().queue
  return printerId ? q.filter((i) => i.printerId === printerId) : q
}
