// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the fit rule needs to set the gaps of a print-in-place part (design.check and geom.fit_check): the layer height
// the plate slices with, and the material of the first filament in use (else the first slot).
import { resolveConfig } from '../adapters/config'
import { resolveSlots } from '../filament/slots'
import type { get } from '../state/store'

export function fitProfileFor(s: ReturnType<typeof get>): { layerHeightMm?: number; material?: string } {
  const layer = Number(resolveConfig(s.easy, s.overrides)['layer_height'])
  const slots = resolveSlots(s)
  const type = (slots.find((x) => x.used) ?? slots[0])?.type
  return { ...(layer > 0 ? { layerHeightMm: layer } : {}), ...(type ? { material: type } : {}) }
}
