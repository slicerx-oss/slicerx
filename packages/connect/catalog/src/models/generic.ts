// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterModel } from '../types.ts'
import { FIND_KLIPPER, find, rect } from './util.ts'

const base = { brand: 'generic', enclosed: false, defaultNozzle: 0.4, nozzleCount: 1 } as const

/** Entries for machines not listed by name. The size is a starting point the user changes. */
export const GENERIC: PrinterModel[] = [
  {
    ...base,
    id: 'generic-klipper',
    name: 'Klipper printer',
    kinematics: 'corexy',
    buildVolume: rect(250, 250, 250),
    nozzles: [0.4],
    connections: ['moonraker', 'bambuddy', 'export'],
    find: FIND_KLIPPER,
    note: 'Any printer that opens in Mainsail or Fluidd. Set your own build volume.',
  },
  {
    ...base,
    id: 'generic-octoprint',
    name: 'Printer behind OctoPrint',
    kinematics: 'bed-slinger',
    buildVolume: rect(220, 220, 250),
    nozzles: [0.4],
    connections: ['octoprint', 'bambuddy', 'export'],
    find: find({
      ip: 'The address of the Raspberry Pi that runs OctoPrint. Your router\'s device list shows it, and OctoPi answers to octopi.local.',
      credential: 'In OctoPrint, open Settings, then Application Keys, and create a key for SlicerX.',
    }),
    note: 'Any printer that OctoPrint controls. Set your own build volume.',
  },
  {
    ...base,
    id: 'generic-duet',
    name: 'Duet board',
    kinematics: 'corexy',
    buildVolume: rect(300, 300, 300),
    nozzles: [0.4],
    connections: ['duet', 'bambuddy', 'export'],
    find: find({
      ip: 'In Duet Web Control, open the G-code console and send M552. The reply shows the address. The board\'s .local name works too.',
      credential: 'The password you set with M551. Boards without one accept the default, reprap.',
    }),
    note: 'Duet 2 and Duet 3 boards with RepRapFirmware 3. Set your own build volume and kinematics.',
  },
  {
    ...base,
    id: 'generic-export',
    name: 'Printer without a connection',
    kinematics: 'bed-slinger',
    buildVolume: rect(220, 220, 250),
    nozzles: [0.4],
    connections: ['export'],
    find: find({ ip: 'Not needed. Save the G-code and carry it to the printer on USB or an SD card.' }),
    note: 'Use this when your printer is not listed and has no network interface SlicerX supports.',
  },
]
