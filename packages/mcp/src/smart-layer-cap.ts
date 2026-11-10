// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Smart layer heights print layers of at most half the nozzle whatever layer_height says, and the default process turns
// them on. A client that sets layer_height above that and leaves smart_layer alone gets thinner layers and a longer
// print than it asked for, so the slice says so. Nothing is changed for it.
import { smartLayerCap } from '@slicerx/settings'

/** The warning for a slice whose overrides set a layer height smart layers pass over, or null. */
export function smartLayerCapNote(config: Readonly<Record<string, unknown>>, overrides: Readonly<Record<string, unknown>> | undefined): string | null {
  if (overrides?.['layer_height'] === undefined || overrides['smart_layer'] !== undefined) return null
  const cap = smartLayerCap(config)
  if (!cap) return null
  const mode = String([config['smart_layer']].flat()[0])
  const layer = cap.layerMm.toFixed(2)
  return `With smart layer heights on (smart_layer ${mode}), layers are at most ${cap.capMm.toFixed(2)} mm, not the ${layer} mm layer_height. Set smart_layer to off for ${layer} mm layers.`
}
