// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterModel } from '../types.ts'
import { find, rect } from './util.ts'

const FIND = find({
  ip: 'Not needed yet. SlicerX does not speak the S series network API, so save G-code and carry it over on a USB stick.',
})

/**
 * The S series: two print cores in one head, the inactive one lifted by the lift switch while the other prints.
 * Sizes and nozzles follow UltiMaker Cura's machine definitions and print core variants.
 */
const s = (id: string, name: string, x: number, y: number, z: number, enclosed: boolean): PrinterModel => ({
  id,
  brand: 'ultimaker',
  name,
  kinematics: 'cartesian',
  enclosed,
  buildVolume: rect(x, y, z),
  nozzles: [0.25, 0.4, 0.6, 0.8],
  defaultNozzle: 0.4,
  nozzleCount: 2,
  connections: ['export'],
  find: FIND,
  note: 'Not connectable yet. Save G-code and carry it over on a USB stick.',
})

export const ULTIMAKER: PrinterModel[] = [
  // The S3 and S5 have front doors but an open top (the S5's air manager is an option).
  s('ultimaker-s3', 'S3', 230, 190, 200, false),
  s('ultimaker-s5', 'S5', 330, 240, 300, false),
  // The S7, S6 and S8 close the build chamber and filter it with the built-in air manager.
  s('ultimaker-s7', 'S7', 330, 240, 300, true),
  s('ultimaker-s6', 'S6', 330, 240, 300, true),
  s('ultimaker-s8', 'S8', 330, 240, 300, true),
]
