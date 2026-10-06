// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterModel } from '../types.ts'
import { find, rect } from './util.ts'

const FIND_2 = find({
  ip: 'On the touchscreen, open Settings, then the Wi-Fi or Network page. The IP address is shown once the machine is connected.',
  credential: 'None to type. After you add the machine, SlicerX asks it to pair and the touchscreen shows a prompt. Tap to allow it within a minute.',
})

const snap2 = (id: string, name: string, x: number, y: number, z: number): PrinterModel => ({
  id,
  brand: 'snapmaker',
  name,
  kinematics: 'bed-slinger',
  enclosed: false,
  buildVolume: rect(x, y, z),
  nozzles: [0.4],
  defaultNozzle: 0.4,
  nozzleCount: 1,
  connections: ['snapmaker', 'export'],
  find: FIND_2,
  note: 'The 3D printing head only. Laser and CNC heads are refused.',
})

export const SNAPMAKER: PrinterModel[] = [
  {
    id: 'snapmaker-u1',
    brand: 'snapmaker',
    name: 'U1',
    kinematics: 'toolchanger',
    enclosed: true,
    buildVolume: rect(270, 270, 270),
    nozzles: [0.4],
    defaultNozzle: 0.4,
    nozzleCount: 4,
    filamentSystem: 'toolchanger',
    connections: ['snapmaker', 'moonraker', 'export'],
    find: find({
      ip: 'On the touchscreen, open Settings, then Network. The IP address is shown with the connected network.',
      credential: 'None on the stock firmware. A key is needed only if you turned on forced logins in custom firmware.',
    }),
    note: 'Runs Klipper with Moonraker. All four toolheads are read.',
  },
  snap2('snapmaker-a150', 'A150', 160, 160, 145),
  snap2('snapmaker-a250', 'A250', 230, 250, 235),
  snap2('snapmaker-a350', 'A350', 320, 350, 330),
  {
    id: 'snapmaker-j1',
    brand: 'snapmaker',
    name: 'J1',
    kinematics: 'idex',
    enclosed: true,
    buildVolume: rect(300, 200, 200),
    nozzles: [0.4],
    defaultNozzle: 0.4,
    nozzleCount: 2,
    connections: ['export'],
    find: find({ ip: 'Not needed yet. A scan finds the J1, but it uses a protocol SlicerX does not speak yet (SACP over TCP 8888).' }),
    note: 'Found by a scan, not connectable yet. Save G-code and carry it over on USB.',
  },
  {
    id: 'snapmaker-artisan',
    brand: 'snapmaker',
    name: 'Artisan',
    kinematics: 'bed-slinger',
    enclosed: true,
    buildVolume: rect(400, 400, 400),
    nozzles: [0.4],
    defaultNozzle: 0.4,
    // Ships with Snapmaker's Dual Extrusion 3D Printing Module (two hot ends), as the maker's product page
    // and its slicer profile (fdm_a400, from fdm_linear2_dual) say.
    nozzleCount: 2,
    connections: ['export'],
    find: find({ ip: 'Not needed yet. A scan finds the Artisan, but it uses a protocol SlicerX does not speak yet (SACP over TCP 8888).' }),
    note: 'Found by a scan, not connectable yet. Save G-code and carry it over on USB.',
  },
]
