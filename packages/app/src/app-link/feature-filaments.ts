// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// feature_filaments.get and feature_filaments.set over the app link, with the MCP server's arguments: the Color tab's
// feature filament table (plate/feature-filaments.ts) for the shown plate or the objects named, read back as the table
// shows it, printed-with slots included. A change writes through the same scope a person's pick in the table does.
import { appFeatureFilamentInputs } from '@slicerx/mcp/toolset'
import { resolveConfig } from '../adapters/settings'
import { resolveSlots } from '../filament/slots'
import { FEATURE_FILAMENT_ROWS, featureFilamentReadback, setFeatureFilaments } from '../plate/feature-filaments'
import type { SettingsScope } from '../plate/scope'
import { get, toast } from '../state/store'
import { LinkError } from './methods-error'
import { refuseWhileBusy } from './project-settings'

function scopeOf(objects: readonly string[] | undefined): SettingsScope {
  if (!objects?.length) return { kind: 'plate' }
  const plate = get().plate
  const ids = objects.map((o) => {
    const e = plate.find((p) => p.id === o) ?? plate.find((p) => p.name === o && !p.instanceOf)
    if (!e) throw new LinkError('not_found', `no object ${o} on the shown plate; plate.list lists them`)
    return e.id
  })
  return { kind: 'objects', ids: [...new Set(ids)] }
}

function read(scope: SettingsScope) {
  const s = get()
  const out = featureFilamentReadback(s, resolveConfig(s.easy, s.overrides), scope)
  const set = out.rows.filter((r) => r.value !== 0).length
  return { summary: `${set ? `${set} of ${out.rows.length} features on a filament of their own` : "Every feature on the object's filament"} for ${scope.kind === 'objects' ? `${scope.ids.length} objects` : 'the plate'}`, output: out }
}

export function readFeatureFilaments(args: Record<string, unknown>) {
  const parsed = appFeatureFilamentInputs['feature_filaments.get'].safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  return read(scopeOf(parsed.data.objects))
}

export function editFeatureFilaments(args: Record<string, unknown>, client: string) {
  const parsed = appFeatureFilamentInputs['feature_filaments.set'].safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const slots = resolveSlots(get()).length
  // Every row is checked before anything changes.
  const entries = Object.entries(parsed.data.filaments).map(([name, value]) => {
    const row = FEATURE_FILAMENT_ROWS.find((r) => r.feature === name || r.key === name)
    if (!row) throw new LinkError('invalid_input', `${name} is not a feature of the table; use one of ${FEATURE_FILAMENT_ROWS.map((r) => r.feature).join(', ')}`)
    if (value !== null && value > slots) throw new LinkError('invalid_input', `filament ${value} is past the project's ${slots} filaments`)
    return [row.key, value ?? undefined] as const
  })
  refuseWhileBusy('which filament prints each feature')
  const scope = scopeOf(parsed.data.objects)
  setFeatureFilaments(get(), scope, entries)
  toast(`${client} changed which filament prints ${entries.length === 1 ? 'a feature' : `${entries.length} features`}.`, 'info')
  return read(scope)
}
