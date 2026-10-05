// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterModel } from '../types.ts'
import { find, rect } from './util.ts'

const FIND_KOBRA = find({
  ip: 'On the touchscreen, open Settings, then the network page. Your router\'s device list shows the address as well.',
  credential: 'None. SlicerX does not connect to this printer yet.',
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
    connections: ['export'],
    find: FIND_KOBRA,
    note: 'SlicerX does not speak the printer\'s network protocol yet. Save the G-code and carry it over on a USB drive.',
  },
]
