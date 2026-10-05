// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The small, always loaded side of the G-code line view: whether the panel is open, the G-code file shown in
// Preview without a project, and the entry points that load the rest (gcode-source.ts) on first use.
import type { FileRef, Host } from '@slicerx/contracts'
import { createStore, useStore } from 'zustand'

export interface GcodeFileInfo {
  name: string
  bytes: number
  lines: number
  /** Estimated from moves and feed rates, no acceleration. */
  timeS: number
  filamentMm: number[]
}

interface GcodeViewState {
  /** The line view is open. */
  panel: boolean
  /** A G-code file opened on its own is in Preview; null while Preview shows the plate's slice. */
  file: GcodeFileInfo | null
  /** A file is being read. */
  reading: string | null
}

export const gcodeView = createStore<GcodeViewState>()(() => ({ panel: false, file: null, reading: null }))

export function useGcodeView<T>(pick: (s: GcodeViewState) => T): T {
  return useStore(gcodeView, pick)
}

export function setGcodePanel(open: boolean): void {
  gcodeView.setState({ panel: open })
}

/** G-code text a person can open to view: plain text only (binary .bgcode has no lines to show). */
export function isGcodeName(name: string): boolean {
  return /\.(gcode|gco|g)$/i.test(name)
}

/** Opens a G-code file in Preview, read into toolpaths and the line view. */
export async function openGcodeRef(host: Host, ref: FileRef): Promise<void> {
  const { openGcodeFile } = await import('./gcode-source')
  await openGcodeFile(host, ref)
}

/** Asks for a G-code file and opens it in Preview. */
export async function pickGcodeFile(host: Host): Promise<void> {
  const [ref] = await host.files.open({ accept: ['.gcode', '.gco', '.g'] })
  if (ref) await openGcodeRef(host, ref)
}

/** Leaves the file and goes back to the plate's own slice, if it has one. */
export async function closeGcodeFile(): Promise<void> {
  const { closeFile } = await import('./gcode-source')
  closeFile()
}
