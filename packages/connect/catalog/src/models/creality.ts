// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterModel } from '../types.ts'
import { find, rect } from './util.ts'

const FIND = find({
  ip: 'On the touchscreen, open Settings, then Wi-Fi (or Network for a cable). Tap the connected network to see the IP address. Your router\'s device list shows it too.',
  credential: 'None. Creality printers need no code or password for this connection, and no root. Moonraker and Fluidd come with the K2 family (Moonraker on 7125, Fluidd on 4408); on a K1 or Ender-3 V3 KE they need root (Settings, then Root account information), which SlicerX does not need.',
})

const creality = (m: Omit<PrinterModel, 'brand' | 'connections' | 'nozzleCount' | 'defaultNozzle' | 'find'> & Partial<PrinterModel>): PrinterModel => ({
  brand: 'creality',
  connections: ['creality', 'moonraker', 'export'],
  nozzleCount: 1,
  defaultNozzle: 0.4,
  find: FIND,
  ...m,
})

const STD = [0.4, 0.6, 0.8]

export const CREALITY: PrinterModel[] = [
  creality({
    id: 'creality-k1',
    name: 'K1',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(220, 220, 250),
    nozzles: STD,
  }),
  creality({ id: 'creality-k1c', name: 'K1C', kinematics: 'corexy', enclosed: true, buildVolume: rect(220, 220, 250), nozzles: STD }),
  creality({ id: 'creality-k1-max', name: 'K1 Max', kinematics: 'corexy', enclosed: true, buildVolume: rect(300, 300, 300), nozzles: STD }),
  creality({ id: 'creality-k1-se', name: 'K1 SE', kinematics: 'corexy', enclosed: false, buildVolume: rect(220, 220, 250), nozzles: STD }),
  creality({
    id: 'creality-k2-plus',
    name: 'K2 Plus',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(350, 350, 350),
    nozzles: STD,
    filamentSystem: 'cfs',
    note: 'Runs Klipper with Moonraker on 7125 out of the box. SlicerX reads the CFS spools over the printer\'s own interface and shows the WebRTC camera.',
  }),
  creality({
    id: 'creality-ender-3-v3',
    name: 'Ender-3 V3',
    kinematics: 'corexz',
    enclosed: false,
    buildVolume: rect(220, 220, 250),
    nozzles: STD,
  }),
  creality({ id: 'creality-ender-3-v3-plus', name: 'Ender-3 V3 Plus', kinematics: 'corexz', enclosed: false, buildVolume: rect(300, 300, 330), nozzles: STD }),
  creality({ id: 'creality-ender-3-v3-se', name: 'Ender-3 V3 SE', kinematics: 'bed-slinger', enclosed: false, buildVolume: rect(220, 220, 250), nozzles: STD }),
  creality({ id: 'creality-ender-3-v3-ke', name: 'Ender-3 V3 KE', kinematics: 'bed-slinger', enclosed: false, buildVolume: rect(220, 220, 240), nozzles: STD }),
  creality({ id: 'creality-hi', name: 'Creality Hi', kinematics: 'corexy', enclosed: true, buildVolume: rect(260, 260, 300), nozzles: STD, filamentSystem: 'cfs' }),
  creality({
    id: 'creality-ender-3-octoprint',
    name: 'Ender-3 with OctoPrint',
    kinematics: 'bed-slinger',
    enclosed: false,
    buildVolume: rect(220, 220, 250),
    nozzles: STD,
    connections: ['octoprint', 'export'],
    find: find({
      ip: 'The address of the Raspberry Pi that runs OctoPrint. Your router\'s device list shows it, and OctoPi answers to octopi.local.',
      credential: 'In OctoPrint, open Settings, then Application Keys, and create a key for SlicerX.',
    }),
    note: 'The original Ender-3 has no network of its own. This entry is for one that sits behind OctoPrint.',
  }),
]
