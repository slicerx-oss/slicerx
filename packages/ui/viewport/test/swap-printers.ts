// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Bambu Lab printers with one nozzle that swap filament at a purge chute, as their profiles resolve
// (packages/profiles/resolved/bambu-lab.json): bed, load and unload seconds, travel acceleration.
import { toolChangerSpec, type ToolChangerSpec } from '../src/toolchanger'

const bed = (w: number, d: number, h: number) => ({ widthMm: w, depthMm: d, heightMm: h })
const cfg = (load: number, unload: number, accel: number) => ({ nozzle_diameter: ['0.4'], machine_load_filament_time: load, machine_unload_filament_time: unload, machine_max_acceleration_travel: [accel, accel] })

export const SWAP_PRINTERS: { name: string; id: string; spec: () => ToolChangerSpec }[] = [
  { name: 'Bambu Lab A1', id: 'bambu-a1', spec: () => toolChangerSpec('bambu-a1', cfg(25, 29, 6000), bed(256, 256, 256), 2)! },
  { name: 'Bambu Lab A1 mini', id: 'bambu-a1-mini', spec: () => toolChangerSpec('bambu-a1-mini', cfg(28, 34, 6000), bed(180, 180, 180), 2)! },
  { name: 'Bambu Lab X1 Carbon', id: 'bambu-x1-carbon', spec: () => toolChangerSpec('bambu-x1-carbon', cfg(29, 28, 9000), bed(256, 256, 250), 2)! },
  { name: 'Bambu Lab X1E', id: 'bambu-x1e', spec: () => toolChangerSpec('bambu-x1e', cfg(29, 28, 9000), bed(256, 256, 250), 2)! },
  { name: 'Bambu Lab P1P', id: 'bambu-p1p', spec: () => toolChangerSpec('bambu-p1p', cfg(29, 28, 9000), bed(256, 256, 250), 2)! },
  { name: 'Bambu Lab P1S', id: 'bambu-p1s', spec: () => toolChangerSpec('bambu-p1s', cfg(29, 28, 9000), bed(256, 256, 250), 2)! },
  { name: 'Bambu Lab H2S', id: 'bambu-h2s', spec: () => toolChangerSpec('bambu-h2s', cfg(29, 28, 9000), bed(340, 320, 340), 2)! },
]
