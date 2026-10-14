// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design toolset: design.* and the geom.* CAD and mesh tools, defined once and run on any design host. The server builds
// them with its files; the app builds the same definitions on its plate, where a model file is not a design and
// every file call says so.
import type { DesignHost } from '@slicerx/cad-history'
import type { PilotTool } from '@slicerx/pilot'
import { cadTools, type CadFiles } from './cad'
import { designTools, type DesignFiles } from './design-tools'
import { ToolInputError } from './errors'
import { modelingTools, type ModelingFiles } from './modeling-tools'

export { appValueInputs, type AppValuesResult } from './app-values'

const noFiles = (): never => {
  throw new ToolInputError('Model files are for the MCP server; here, give a design instead.', 'not_supported')
}

/** Files where there are none: every call refuses with not_supported. */
export const NO_DESIGN_FILES: DesignFiles = { model: async () => noFiles(), open: async () => noFiles(), save: async () => noFiles() }
export const NO_CAD_FILES: CadFiles = { engine: false, call: async () => noFiles(), path: async () => noFiles(), stl: () => noFiles() }
export const NO_MODELING_FILES: ModelingFiles = { call: async () => noFiles(), mesh: async () => noFiles() }

/** A host for a server with no geometry engine: every design call says so (the app link may still take them). */
export const NO_ENGINE_HOST: DesignHost = {
  get: () => noEngine(),
  list: () => [],
  create: async () => noEngine(),
  add: async () => noEngine(),
  replay: async () => noEngine(),
  call: async () => noEngine(),
}

function noEngine(): never {
  throw new ToolInputError('Designs need the sx-geom engine, which this server did not find, or the app link to the open app.', 'engine_unavailable')
}

/** The design tools and the CAD tools on `host`, with the files the caller has. */
export function designToolset(host: DesignHost, files: { design?: DesignFiles; cad?: CadFiles; modeling?: ModelingFiles } = {}): PilotTool<never>[] {
  return [...designTools(host, files.design ?? NO_DESIGN_FILES), ...cadTools({ files: files.cad ?? NO_CAD_FILES, designs: host }), ...modelingTools({ files: files.modeling ?? NO_MODELING_FILES, designs: host })]
}
