// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { cutInput } from '@slicerx/mcp/toolset'
import { CutError, cutObject } from '../plate/cut-object'
import { clearanceFor } from '../plate/clearance'
import { history } from '../plate/history'
import { get, toast } from '../state/store'
import { objectState } from './object-state'
import { LinkError } from './methods-error'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

export async function cut(args: Record<string, unknown>, client: string, loader: Loader) {
  const parsed = cutInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  const input = parsed.data
  const plate = get().plate
  const byId = plate.find((e) => e.id === input.object)
  const matches = byId ? [byId] : plate.filter((e) => e.name === input.object)
  if (!matches.length) throw new LinkError('not_found', 'No such object on the shown plate; read plate.list and choose an id.')
  if (matches.length !== 1) throw new LinkError('invalid_input', 'That name matches several objects; choose one by id.')
  const entry = matches[0]!
  const connector = input.connector
  try {
    const result = await cutObject(loader, entry.id, {
      ...('axis' in input.plane ? { axis: input.plane.axis, atMm: input.plane.at } : { axis: 'z' as const, atMm: 0, plane: input.plane }),
      keep: input.keep,
      ...(connector ? { connector: { kind: connector.kind, diameterMm: connector.diameter_mm, depthMm: connector.depth_mm, toleranceMm: connector.tolerance_mm ?? clearanceFor(get()).mm, ...(connector.count !== undefined ? { count: connector.count } : {}), ...(connector.positions ? { positions: connector.positions } : {}) } } : {}),
    })
    const summary = result.changed ? `Cut ${entry.name} into ${result.ids.length} objects.` : `No change to ${entry.name}.`
    if (result.changed) toast(`${client}: ${summary}${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`, result.warnings.length ? 'warn' : 'info', { label: 'Undo', run: () => void history().undo() })
    const objects = get().plate.filter((e) => result.ids.includes(e.id)).map(objectState)
    return { summary, output: { ...result, objects } }
  } catch (error) {
    if (error instanceof CutError) throw new LinkError(error.code, error.message)
    throw error
  }
}
