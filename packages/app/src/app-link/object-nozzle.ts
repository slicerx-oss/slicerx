// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// project.object_nozzle over the app link, with the MCP server's arguments: print an object on the shown plate with
// another nozzle, on a printer whose nozzles are not all one size, as the nozzle chip in the object list does. The
// person sees a toast naming the client, with Undo, and the answer reads back the object's nozzle and the plate's map.
import { resolveConfig } from '../adapters/config'
import { mapSource, nozzleKind, nozzleLabel, nozzleSizes, objectNozzle as nozzleOf, plateMap, setObjectNozzle } from '../filament/object-nozzle'
import { resolveSlots } from '../filament/slots'
import { history } from '../plate/history'
import { activeMeta } from '../plate/plates'
import { get, toast } from '../state/store'
import { LinkError } from './methods-error'

const flag = (v: unknown, key: string): boolean | undefined => {
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new LinkError('invalid_input', `${key} is true or false`)
  return v
}

/** The printer's nozzles, the plate's map and where it comes from, as a client reads them back. */
export function nozzleReadback() {
  const s = get()
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, unknown>
  const kind = nozzleKind(cfg)
  if (!kind) return { nozzles: nozzleSizes(cfg).map((mm, i) => ({ nozzle: i + 1, mm })), sizesDiffer: false }
  const meta = activeMeta(s)
  return {
    nozzles: nozzleSizes(cfg).map((mm, i) => ({ nozzle: i + 1, name: nozzleLabel(cfg, i + 1), mm })),
    sizesDiffer: true,
    ...(kind === 'map' ? { filamentMap: { mode: mapSource(s, meta, cfg), map: plateMap(s, meta, cfg, resolveSlots(s).length) } } : {}),
    objects: s.plate.map((e) => {
      const n = nozzleOf(s, e, cfg)
      return { id: e.id, name: e.name, ...(n && 'extruder' in n ? { nozzle: n.extruder, nozzleMm: n.mm } : n ? { nozzle: null, conflict: n.conflict } : {}) }
    }),
  }
}

export async function objectNozzle(args: Record<string, unknown>, client: string) {
  const object = args['object']
  const nozzle = args['nozzle']
  if (typeof object !== 'string' || !object) throw new LinkError('invalid_input', 'object is an id or a name from plate.list')
  if (typeof nozzle !== 'number' || !Number.isInteger(nozzle)) throw new LinkError('invalid_input', 'nozzle is a whole number from 1')
  const filament = args['filament']
  if (filament !== undefined && (typeof filament !== 'number' || !Number.isInteger(filament))) throw new LinkError('invalid_input', 'filament is a whole number from 1')
  const e = get().plate.find((p) => p.id === object) ?? get().plate.find((p) => p.name === object && !p.instanceOf)
  if (!e) throw new LinkError('not_found', `no object ${object} on the shown plate; plate.list lists them`)
  if (e.locked) throw new LinkError('refused', `${e.name} is locked; the person unlocks it in the object list`)
  const r = setObjectNozzle(e.id, nozzle, { filament: filament as number | undefined, newFilament: flag(args['new_filament'], 'new_filament'), moveFilament: flag(args['move_filament'], 'move_filament'), confirmPainted: flag(args['confirm_painted'], 'confirm_painted') })
  if (!r.ok) throw new LinkError(r.reason === 'no_object' ? 'not_found' : r.reason === 'one_size' ? 'refused' : 'invalid_input', r.message, r.painted ? { painted: r.painted } : r.sharedWith ? { sharedWith: r.sharedWith } : undefined)
  const cfg = resolveConfig(get().easy, get().overrides) as Record<string, unknown>
  toast(`${client} set ${e.name} to the ${nozzleLabel(cfg, r.extruder).replace(/^Left|^Right|^Tool/, (w) => w.toLowerCase())}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  return { summary: `${e.name} prints with ${nozzleLabel(cfg, r.extruder)} (filament ${r.filament})`, output: { object: e.id, nozzle: r.extruder, filament: r.filament, ...(r.added ? { added: r.added } : {}), ...(r.paintSplit ? { paintSplit: r.paintSplit } : {}), ...nozzleReadback() } }
}
