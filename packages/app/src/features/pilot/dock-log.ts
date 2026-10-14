// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The docked chat's conversations for the read-back over the app link: every event the runtime logs, and the person's
// messages beside them (the runtime logs only its own events), with each message's files by name.
import { createMemorySessionStore } from '@slicerx/pilot'

export const dockLogs = createMemorySessionStore()

const messages = new Map<string, { text: string; attachments: string[] }[]>()

export function noteDockMessage(sessionId: string, text: string, files: readonly { name: string }[] = []): void {
  const list = messages.get(sessionId) ?? []
  list.push({ text, attachments: files.map((f) => f.name) })
  messages.set(sessionId, list)
}

export function dockMessages(sessionId: string): { text: string; attachments: string[] }[] {
  return messages.get(sessionId) ?? []
}
