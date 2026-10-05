// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { Kinematics, PrinterModel } from '../types.ts'
import { FIND_KLIPPER, find, rect, round } from './util.ts'

/** Nozzle sizes offered for Voron builds. */
const VORON_NOZZLES = [0.15, 0.2, 0.25, 0.4, 0.5, 0.6, 0.8, 1.0]

const voron = (id: string, name: string, kinematics: Kinematics, x: number, y: number, z: number): PrinterModel => ({
  id,
  brand: 'voron',
  name,
  kinematics,
  enclosed: true,
  buildVolume: rect(x, y, z),
  nozzles: VORON_NOZZLES,
  defaultNozzle: 0.4,
  nozzleCount: 1,
  connections: ['moonraker', 'export'],
  find: FIND_KLIPPER,
  note: 'The build volume is the standard one for this size. Your build may differ.',
})

const klipper = (m: Omit<PrinterModel, 'connections' | 'nozzleCount' | 'defaultNozzle' | 'find'> & Partial<PrinterModel>): PrinterModel => ({
  connections: ['moonraker', 'export'],
  nozzleCount: 1,
  defaultNozzle: 0.4,
  find: FIND_KLIPPER,
  ...m,
})

export const KLIPPER: PrinterModel[] = [
  voron('voron-0.1', 'Voron 0.1', 'corexy', 120, 120, 120),
  voron('voron-2.4-250', 'Voron 2.4 250', 'corexy', 250, 250, 225),
  voron('voron-2.4-300', 'Voron 2.4 300', 'corexy', 300, 300, 275),
  voron('voron-2.4-350', 'Voron 2.4 350', 'corexy', 350, 350, 325),
  voron('voron-trident-250', 'Voron Trident 250', 'corexy', 250, 250, 250),
  voron('voron-trident-300', 'Voron Trident 300', 'corexy', 300, 300, 250),
  voron('voron-trident-350', 'Voron Trident 350', 'corexy', 350, 350, 250),
  { ...voron('voron-switchwire-250', 'Voron Switchwire 250', 'corexz', 250, 210, 240), enclosed: false },
  klipper({
    id: 'qidi-q1-pro',
    brand: 'qidi',
    name: 'Q1 Pro',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(245, 245, 240),
    nozzles: [0.4, 0.6],
  }),
  klipper({
    id: 'qidi-x-plus-4',
    brand: 'qidi',
    name: 'X-Plus 4',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(305, 305, 280),
    nozzles: [0.4, 0.6],
  }),
  klipper({ id: 'sovol-sv08', brand: 'sovol', name: 'SV08', kinematics: 'corexy', enclosed: true, buildVolume: rect(350, 350, 345), nozzles: [0.4, 0.6] }),
  klipper({
    id: 'sovol-sv04',
    brand: 'sovol',
    name: 'SV04',
    kinematics: 'idex',
    enclosed: false,
    buildVolume: rect(300, 300, 400),
    nozzles: [0.4],
    nozzleCount: 2,
    connections: ['octoprint', 'export'],
    find: find({
      ip: 'The address of the Raspberry Pi that runs OctoPrint. Your router\'s device list shows it.',
      credential: 'In OctoPrint, open Settings, then Application Keys, and create a key for SlicerX.',
    }),
    note: 'Runs Marlin. The stock machine has no network, so this entry is for one behind OctoPrint.',
  }),
  klipper({
    id: 'flsun-v400',
    brand: 'flsun',
    name: 'V400',
    kinematics: 'delta',
    enclosed: false,
    buildVolume: round(300, 410),
    nozzles: [0.4, 0.6],
  }),
  klipper({
    id: 'generic-klipper-delta',
    brand: 'generic',
    name: 'Klipper delta',
    kinematics: 'delta',
    enclosed: false,
    buildVolume: round(250, 300),
    nozzles: [0.4],
    note: 'A starting size. Set your own bed diameter and height.',
  }),
]
