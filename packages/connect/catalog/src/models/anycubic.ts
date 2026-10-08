// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterModel } from '../types.ts'
import { find, rect } from './util.ts'

const FIND_KOBRA = find({
  ip: 'On the touchscreen, open Settings, then Network. Your router\'s device list shows the address as well.',
  credential: 'No code. In Settings > Network, turn on LAN Mode. This removes the printer from your Anycubic account for good; turning it off later does not bring it back, so you would pair it again in the Anycubic app.',
})

export const ANYCUBIC: PrinterModel[] = [
  {
    id: 'anycubic-kobra-x',
    brand: 'anycubic',
    name: 'Kobra X',
    kinematics: 'bed-slinger',
    enclosed: false,
    buildVolume: rect(260, 260, 260),
    nozzles: [0.4],
    defaultNozzle: 0.4,
    nozzleCount: 1,
    connections: ['anycubic', 'bambuddy', 'export'],
    find: FIND_KOBRA,
    note: 'Experimental: the LAN Mode connection is untested on a printer.',
  },
]
