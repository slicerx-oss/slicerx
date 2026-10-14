// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { settingDef } from './schema'

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
const metadata = new Set(['print_extruder_id', 'print_extruder_variant', 'filament_self_index', 'filament_extruder_variant', 'printer_extruder_id', 'printer_extruder_variant'])
export class ProjectVariantError extends Error {
  override readonly name = 'ProjectVariantError'
  constructor(reason: string) { super(`Project variants: ${reason}`) }
}

const fail = (reason: string): never => { throw new ProjectVariantError(reason) }
const positiveId = (s: string): number => /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : fail(`invalid identity ${s}`)

/** Select settings by their explicit identities and the project's selected nozzle variants. */
export function selectVariants(raw: Record<string, unknown>): Record<string, unknown> {
  const ids = list(raw['print_extruder_id'])
  const pv = list(raw['print_extruder_variant'])
  const fv = list(raw['filament_extruder_variant'])
  const self = list(raw['filament_self_index'])
  const types = list(raw['extruder_type'])
  const volumes = list(raw['nozzle_volume_type'])
  const filaments = Math.max(list(raw['filament_settings_id']).length, list(raw['filament_colour']).length)
  const extruders = [...new Set(ids)].sort((a, b) => Number(a) - Number(b))
  const physical = Math.max(types.length, volumes.length, list(raw['nozzle_diameter']).length, 1)
  const active = (e: number): string => `${types[e] ?? types[0] ?? 'Direct Drive'} ${volumes[e] ?? volumes[0] ?? 'Standard'}`
  const map = list(raw['filament_map'])
  const match = (names: string[], owners: string[], owner: string, variant: string): number => {
    const found = names.flatMap((name, i) => owners[i] === owner && name === variant ? [i] : [])
    if (found.length !== 1) fail(`identity ${owner} needs exactly one ${variant} entry; found ${found.length}`)
    return found[0]!
  }
  const filamentExtruder = (f: number): number => {
    if (map.length) {
      const e = positiveId(map[f] ?? '') - 1
      if (e >= physical) fail(`filament ${f + 1} maps to unavailable extruder ${e + 1}`)
      return e
    }
    if (Array.from({ length: physical }, (_, e) => active(e)).some((name) => name !== active(0))) fail('filament_map is required when extruders have different variants')
    return 0
  }
  const filamentOwners = (): string[] => {
    if (self.length) {
      if (self.length !== fv.length) fail('filament_self_index and filament_extruder_variant have different lengths')
      return self.map((id) => {
        const n = positiveId(id)
        if (n > filaments) fail(`filament identity ${id} has no filament slot`)
        return String(n)
      })
    }
    if (fv.length % filaments !== 0) fail('filament variants need explicit identities for unequal groups')
    const per = fv.length / filaments
    const first = fv.slice(0, per).sort()
    if (new Set(first).size !== per) fail('legacy filament variants contain duplicate names')
    for (let f = 1; f < filaments; f++) {
      if (fv.slice(f * per, (f + 1) * per).sort().some((name, i) => name !== first[i])) fail('legacy filament variant groups do not match')
    }
    return fv.map((_, i) => String(Math.floor(i / per) + 1))
  }
  const out: Record<string, unknown> = { ...raw }
  let processSelection: number[] | undefined
  let filamentSelection: number[] | undefined
  let owners: string[] | undefined
  for (const [key, values] of Object.entries(raw)) {
    if (!Array.isArray(values) || metadata.has(key)) continue
    const section = settingDef(key)?.section
    if (section === 'process' && pv.length > extruders.length && values.length === pv.length) {
      if (!extruders.length || ids.length !== pv.length) fail('process variant identities are missing or have different lengths')
      if (extruders.some((id, e) => positiveId(id) !== e + 1 || e >= physical)) fail('process variant identities must cover contiguous physical extruders')
      processSelection ??= extruders.map((id) => match(pv, ids, id, active(positiveId(id) - 1)))
      out[key] = processSelection.map((i) => values[i])
    } else if (section === 'filament' && filaments > 0 && fv.length > filaments && values.length === fv.length) {
      owners ??= filamentOwners()
      filamentSelection ??= Array.from({ length: filaments }, (_, f) => match(fv, owners!, String(f + 1), active(filamentExtruder(f))))
      out[key] = filamentSelection.map((i) => values[i])
    }
  }
  return out
}
