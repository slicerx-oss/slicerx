// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's 3MF writer: the shared one (@slicerx/threemf, packages/threemf/src/project.ts), which the MCP server
// writes with too, so a file saved in the app and one saved over MCP have the same layout. The app adds its
// edition's name as the producer and takes the store's plates.
import { projectFiles as filesOf, writeProject as write, writeProjectCompressed as writeCompressed, type ProjectInput as FileInput } from '@slicerx/threemf'
import type { ZipInput } from '@slicerx/threemf/zip'
import type { NamedValue } from '../cad/value-names'
import { appName } from '../edition'
import type { PlateMeta } from '../state/store'

export { BAMBU_MODEL_IDS, dimensionsJson, gcodeLabelIds, gcodeThumbnails, plateFilamentMap, plateJson, sliceInfoXml, sliceMachine, transformAttr, withoutThumbnails, type FilamentMapOut, type PaintOfPart, type PlateFootprint, type SliceMachine } from '@slicerx/threemf'

export interface ProjectInput extends Omit<FileInput, 'plates' | 'application' | 'namedValues'> {
  plates: readonly PlateMeta[]
  /** The producer named in the model; the edition's name when absent. */
  application?: string
  /** The project's named values (cad/values.ts), written as Metadata/slicerx_values.json. */
  namedValues?: readonly NamedValue[]
}

const named = (input: ProjectInput): FileInput => ({ ...input, application: input.application ?? appName() })

export function projectFiles(input: ProjectInput, splitAt?: number): ZipInput[] {
  return filesOf(named(input), splitAt)
}

export function writeProject(input: ProjectInput): Uint8Array {
  return write(named(input))
}

/** Same file, deflated: what a save writes. */
export function writeProjectCompressed(input: ProjectInput): Promise<Uint8Array> {
  return writeCompressed(named(input))
}
