// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Vault's starter designs the gate opens and slices on the A1, by slug: the app's layered X and the set built by
// packages/app/scripts/starter-parts.ts. scripts/gate/gate.test.mjs fails when that file gains or loses a starter or
// the tower's temperatures change without this list.
export const STARTERS = [
  'x-mark',
  'calibration-cube-20mm',
  'wall-hook',
  'cable-clip',
  'shelf-bracket',
  'overhang-test',
  'bridging-test',
  'retraction-test',
  'first-layer-test',
  'temperature-tower',
]

/** The temperature tower: one M104 per floor, from the bottom up. */
export const TOWER = { slug: 'temperature-tower', temps: [230, 225, 220, 215, 210, 205, 200], floorMm: 10 }

/** The printer every starter is sliced on: a Bambu Lab A1 with a 0.4 mm nozzle and PLA, added with no connection. */
export const PRINTER = { model: 'bambu-a1', search: 'A1', name: 'A1', nozzleMm: 0.4, filament: 'PLA' }
