// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterModel } from '../types.ts'
import { find, rect } from './util.ts'

const FIND_PRUSALINK = find({
  ip: 'On the printer screen, open Settings, then Network. The status of the Wi-Fi or Ethernet connection shows the IP address.',
  credential: 'In Settings, Network, open PrusaLink. It shows the user name (maker) and the password or API key to use. Menu names depend on the firmware version.',
})

const NOZZLES = [0.25, 0.4, 0.6, 0.8]
const prusa = (m: Omit<PrinterModel, 'brand' | 'connections' | 'nozzleCount' | 'defaultNozzle' | 'find'> & Partial<PrinterModel>): PrinterModel => ({
  brand: 'prusa',
  connections: ['prusalink', 'octoprint', 'export'],
  nozzleCount: 1,
  defaultNozzle: 0.4,
  find: FIND_PRUSALINK,
  ...m,
})

export const PRUSA: PrinterModel[] = [
  prusa({
    id: 'prusa-mk4s',
    name: 'MK4S',
    kinematics: 'bed-slinger',
    enclosed: false,
    buildVolume: rect(250, 210, 220),
    nozzles: NOZZLES,
    filamentSystem: 'mmu',
    note: 'The MMU3 is an add-on.',
  }),
  prusa({ id: 'prusa-mk4', name: 'MK4', kinematics: 'bed-slinger', enclosed: false, buildVolume: rect(250, 210, 220), nozzles: NOZZLES, filamentSystem: 'mmu' }),
  prusa({ id: 'prusa-mk3.9', name: 'MK3.9', kinematics: 'bed-slinger', enclosed: false, buildVolume: rect(250, 210, 210), nozzles: NOZZLES, filamentSystem: 'mmu' }),
  prusa({ id: 'prusa-mini-plus', name: 'MINI+', kinematics: 'bed-slinger', enclosed: false, buildVolume: rect(180, 180, 180), nozzles: [0.25, 0.4, 0.6] }),
  prusa({ id: 'prusa-core-one', name: 'Core One', kinematics: 'corexy', enclosed: true, buildVolume: rect(250, 220, 270), nozzles: NOZZLES, filamentSystem: 'mmu' }),
  prusa({ id: 'prusa-xl', name: 'XL', kinematics: 'corexy', enclosed: false, buildVolume: rect(360, 360, 360), nozzles: NOZZLES }),
  prusa({
    id: 'prusa-xl-5-toolhead',
    name: 'XL, 5 toolheads',
    kinematics: 'toolchanger',
    enclosed: false,
    buildVolume: rect(360, 360, 360),
    nozzles: NOZZLES,
    nozzleCount: 5,
    filamentSystem: 'toolchanger',
  }),
]
