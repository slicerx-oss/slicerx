// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab's mimir and its conversations. One runtime for the window; every event lands in a session log, which the
// read-back for clients serves, and the person's messages are kept beside it (the runtime logs only its own events).
import type { MeshHandle, MeshPart, Pilot } from '@slicerx/contracts'
import { designToolset } from '@slicerx/mcp/toolset'
import { createMemorySessionStore } from '@slicerx/pilot'
import { motionReduced } from '@slicerx/ui'
import { appDesignHost } from '../../cad/design-host'
import { setMimirLink } from './connection'
import { mimirTools, scriptedMimir } from './scripted'
import { SCRIPTS } from './scripts'

export const mimirLogs = createMemorySessionStore()

/** The person's messages per session, in order. */
export const mimirMessages = new Map<string, { text: string; attachments: string[] }[]>()

let pilot: Pilot | null = null

/**
 * The tab's mimir, made on first use, with the design tools on the plate: a step it makes is the history step a
 * person's edit makes. Scripted replies stream at a reading pace, at once under reduced motion.
 */
export function tabMimir(loader: { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }): Pilot {
  if (!pilot) {
    const still = motionReduced()
    pilot = scriptedMimir(SCRIPTS, mimirTools(designToolset(appDesignHost(loader))), { store: mimirLogs, delayMs: still ? 0 : 28, callDelayMs: still ? 0 : 350 })
    // The stub answers: the chat says so, and the ravens stay behind it.
    setMimirLink('scripted')
  }
  return pilot
}

export function newSessionId(): string {
  return `mimir_${Date.now().toString(36)}`
}

export function noteMessage(sessionId: string, text: string, attachments: readonly { name: string }[]): void {
  const list = mimirMessages.get(sessionId) ?? []
  list.push({ text, attachments: attachments.map((a) => a.name) })
  mimirMessages.set(sessionId, list)
}
