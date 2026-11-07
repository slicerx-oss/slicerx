// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads, sets and resets a plate's own layer heights (plate/layer-profile.ts) through the app link, as the
// layer height editor does. Each change is one toolbar Undo step, and the answer is the plate's profile read back.
import { layerProfileEditInput, layerProfileReadInput } from '@slicerx/mcp/toolset'
import { cleanProfile, layerLimits, plateTopMm, profileTops } from '../plate/layer-profile'
import { history } from '../plate/history'
import { findPlate } from '../plate/plate-step'
import { allPlates, setPlateLayerProfile } from '../plate/plates'
import { toolStore } from '../plate/tools'
import { plateSliceConfig } from '../state/slice-plate'
import { get, toast } from '../state/store'
import { LinkError } from './methods-error'

function plateOf(ref: number | string | undefined) {
  const s = get()
  const id = ref === undefined ? s.activePlate : findPlate(s.plates, ref)
  const meta = allPlates(s).find((p) => p.id === id)
  if (!id || !meta) throw new LinkError('not_found', `no plate ${String(ref)}; app_plates lists the project's plates`)
  return { id, meta, number: s.plates.findIndex((p) => p.id === id) + 1 }
}

/**
 * The plate's profile and what it slices with, read back, in the slice's order: a calibration plate keeps its bands and
 * a resume plan its layers (on the shown plate), whatever profile the plate has; then its own layer heights, sleipnir,
 * or the fixed layer height.
 */
function read(ref: number | string | undefined) {
  const s = get()
  const { id, meta, number } = plateOf(ref)
  const config = plateSliceConfig(s, meta)
  const limits = layerLimits(config)
  const top = plateTopMm(meta.objects)
  const profile = meta.settings.layerProfile ?? null
  const sleipnir = String(config['smart_layer'] ?? 'off') !== 'off'
  const tops = profile && top > 0 ? profileTops(cleanProfile(profile, limits)?.points ?? [], top, limits) : null
  const mode = s.calibration[id] ? 'calibration' : id === s.activePlate && s.resume?.layerTopsMm?.length ? 'resume' : profile ? 'own' : sleipnir ? 'sleipnir' : 'fixed'
  const kept = profile && (mode === 'calibration' || mode === 'resume') ? ', and its own layer heights wait until that ends' : ''
  const words = { calibration: `the calibration's layer heights${kept}`, resume: `the layers of the print it resumes${kept}`, own: `its own layer heights${tops ? `, ${tops.length} layers` : ''}`, sleipnir: 'sleipnir (adaptive layers)', fixed: `a fixed ${Number(config['layer_height'])} mm layer height` }[mode]
  return {
    summary: `Plate ${number} slices with ${words}.`,
    output: {
      plate: { number, id, name: meta.name, shown: id === s.activePlate },
      mode,
      profile: profile ? profile.map(([z, h]) => [z, h]) : null,
      limits: { min_mm: limits.minMm, max_mm: limits.maxMm, first_layer_mm: limits.firstMm },
      top_mm: Math.round(top * 1e4) / 1e4,
      ...(tops ? { layers: tops.length } : {}),
      layer_height_mm: Number(config['layer_height']),
      revision: history().state().revision,
    },
  }
}

export function readLayerProfile(args: Record<string, unknown>) {
  const parsed = layerProfileReadInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  return read(parsed.data.plate)
}

export function editLayerProfile(args: Record<string, unknown>, client: string) {
  const parsed = layerProfileEditInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const i = parsed.data
  const s = get()
  if (s.plateLoading || s.dragging || s.liveEdit || s.historyEdit || s.rollback || s.slice.status === 'running' || ['paint', 'brim', 'face', 'probe'].includes(toolStore.getState().tool)) {
    throw new LinkError('busy', 'Finish the current load, slice, tool or history edit first')
  }
  if (i.revision !== undefined && i.revision !== history().state().revision) throw new LinkError('busy', 'The project changed; read app_layer_profile again before editing')
  const { id, meta, number } = plateOf(i.plate)
  if (i.action === 'reset') {
    const had = Boolean(meta.settings.layerProfile)
    if (had) {
      setPlateLayerProfile(id, null)
      toast(`${client} cleared the layer heights of plate ${number}.`, 'info', { label: 'Undo', run: () => void history().undo() })
    }
    const out = read(id)
    return { ...out, output: { ...out.output, action: i.action, changed: had } }
  }
  // Heights outside what the printer prints are refused, not moved: the client says what it means.
  const limits = layerLimits(plateSliceConfig(s, meta))
  const bad = i.points!.find(([, h]) => h < limits.minMm - 1e-9 || h > limits.maxMm + 1e-9)
  if (bad) throw new LinkError('invalid_input', `layer height ${bad[1]} mm is outside what this printer prints, ${limits.minMm} to ${limits.maxMm} mm`)
  const clean = cleanProfile(i.points!, limits)!
  setPlateLayerProfile(id, clean.points)
  toast(`${client} set the layer heights of plate ${number}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  const out = read(id)
  return { ...out, output: { ...out.output, action: i.action, changed: true } }
}
