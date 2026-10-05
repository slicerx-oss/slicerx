// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pictures of catalog printers for the model grid: the makers' cover images from the OrcaSlicer
// profile resources, 240 px webp in packages/profiles/printer-images (AGPL-3.0-or-later, see
// REUSE.toml). A model without one gets the drawn placeholder. A test keeps this list and the
// folder in step.

/** Catalog model ids that have a picture. */
export const IMAGE_IDS: ReadonlySet<string> = new Set([
  'anycubic-kobra-x',
  'bambu-a1-mini',
  'bambu-a1',
  'bambu-h2c',
  'bambu-h2d',
  'bambu-h2s',
  'bambu-p1p',
  'bambu-p1s',
  'bambu-p2s',
  'bambu-x1-carbon',
  'bambu-x1',
  'bambu-x1e',
  'creality-ender-3-octoprint',
  'creality-ender-3-v3-ke',
  'creality-ender-3-v3-plus',
  'creality-ender-3-v3-se',
  'creality-ender-3-v3',
  'creality-hi',
  'creality-k1-max',
  'creality-k1-se',
  'creality-k1',
  'creality-k1c',
  'creality-k2-plus',
  'elegoo-centauri-carbon',
  'elegoo-neptune-4-max',
  'elegoo-neptune-4-plus',
  'elegoo-neptune-4-pro',
  'elegoo-neptune-4',
  'flsun-v400',
  'prusa-core-one',
  'prusa-mini-plus',
  'prusa-mk4',
  'prusa-mk4s',
  'prusa-xl-5-toolhead',
  'prusa-xl',
  'qidi-q1-pro',
  'qidi-x-plus-4',
  'snapmaker-a250',
  'snapmaker-a350',
  'snapmaker-artisan',
  'snapmaker-j1',
  'snapmaker-u1',
  'sovol-sv08',
  'ultimaker-s5',
  'voron-0.1',
  'voron-2.4-250',
  'voron-2.4-300',
  'voron-2.4-350',
  'voron-switchwire-250',
  'voron-trident-250',
  'voron-trident-300',
  'voron-trident-350',
])

/** The picture of a catalog model, or null when it has none and the placeholder shows. */
export function printerImage(modelId: string): string | null {
  return IMAGE_IDS.has(modelId) ? new URL(`../../../profiles/printer-images/${modelId}.webp`, import.meta.url).href : null
}
