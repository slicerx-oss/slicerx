// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the server's own tools work with. Each tool is one file in this folder that takes these and returns its
// definition (or null when the server lacks what it needs); index.ts lists them, and the server, the command line
// and the tool docs all read that one list.
import type { DataStore } from '../data'
import type { GateDeps } from '../gate'
import type { PathPolicy } from '../models'
import type { PrinterBackend } from '../printers'
import type { ProfileCatalog } from '../profiles'
import type { SlicerBackend } from '../slicer'
import { defineTool, type PilotTool } from '@slicerx/pilot'

export interface ServerToolDeps {
  store: DataStore
  profiles: ProfileCatalog
  policy: PathPolicy
  slicer: SlicerBackend | undefined
  slicerUnavailable?: string | undefined
  printers: PrinterBackend | undefined
  /** This session's gate: approvals are per session over HTTP. */
  gate: GateDeps
}

export type ServerToolFactory = (deps: ServerToolDeps) => PilotTool<never> | null

/** A server tool's definition, typed for the list. */
export const serverTool = <I>(t: PilotTool<I>): PilotTool<never> => defineTool(t) as unknown as PilotTool<never>
