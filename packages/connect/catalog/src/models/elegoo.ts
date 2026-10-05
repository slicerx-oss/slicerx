// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterModel } from '../types.ts'
import { find, rect } from './util.ts'

const FIND_CC = find({
  ip: 'On the touchscreen, open Settings, then Network. The connected Wi-Fi network shows the IP address. Your router\'s device list shows it too.',
  credential: 'None. If your firmware has a network control setting, turn it on.',
})

const FIND_NEPTUNE = find({
  ip: 'On the touchscreen, open Settings, then the network page. Your router\'s device list shows the address as well.',
  credential: 'Usually none. Neptune 4 printers run Klipper with Moonraker; see the Moonraker guide if the connection is rejected.',
})

const NEPTUNE = (id: string, name: string, x: number, y: number, z: number): PrinterModel => ({
  id,
  brand: 'elegoo',
  name,
  kinematics: 'bed-slinger',
  enclosed: false,
  buildVolume: rect(x, y, z),
  nozzles: [0.4, 0.6, 0.8],
  defaultNozzle: 0.4,
  nozzleCount: 1,
  connections: ['moonraker', 'export'],
  find: FIND_NEPTUNE,
})

export const ELEGOO: PrinterModel[] = [
  {
    id: 'elegoo-centauri-carbon',
    brand: 'elegoo',
    name: 'Centauri Carbon',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(256, 256, 256),
    nozzles: [0.2, 0.4, 0.6, 0.8],
    defaultNozzle: 0.4,
    nozzleCount: 1,
    connections: ['elegoo', 'export'],
    find: FIND_CC,
  },
  NEPTUNE('elegoo-neptune-4', 'Neptune 4', 230, 230, 265),
  NEPTUNE('elegoo-neptune-4-pro', 'Neptune 4 Pro', 230, 230, 265),
  NEPTUNE('elegoo-neptune-4-plus', 'Neptune 4 Plus', 320, 320, 385),
  NEPTUNE('elegoo-neptune-4-max', 'Neptune 4 Max', 420, 420, 480),
]
