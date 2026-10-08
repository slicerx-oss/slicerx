// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PrinterModel } from '../types.ts'
import { find, rect } from './util.ts'

// Screen paths from Bambu Lab's wiki ("How to enable Developer Mode on Bambu Lab printers", "How to Connect
// the Printer Using the Access Code") and docs/printer-connect-guide.md: the LAN Only page shows the IP
// address and the access code.
const SERIAL = 'Printed on the label at the back of the machine, and shown under Device in Bambu Studio. A scan reads it from the printer.'

// Developer Mode first came with firmware X1 01.08.03.00, P1 01.08.02.00, A1 01.05.00.00 and H2D 01.01.00.01;
// on that firmware or newer the printer refuses prints and commands from other apps without it, but still sends
// status (Bambu Lab's third-party integration page). So it is optional: without it, prints go through Bambu Connect.
const LIVEVIEW = 'Turn on LAN Only Liveview too if you want the camera.'
const CODE = 'The access code (8 characters) is shown there. If the printer later refuses it, read it again there.'
const REACH = 'If the printer can\'t be reached, turn on LAN Only Mode there.'
const DIRECT = (firmware: string) => `Optional, for printing directly: with LAN Only Mode on, turn on Developer Mode (${firmware} and later). Without it, prints go through Bambu Connect, where you press Print.`

const FIND_X1 = find({
  ip: 'On the touchscreen, open Settings, then LAN Only. The IP address is shown there.',
  credential: `Open the same LAN Only page. ${CODE} ${REACH} ${LIVEVIEW} ${DIRECT('firmware 01.08.03.00')} Keep a micro SD card in the printer: an X1 needs one to start a print sent over the network.`,
  serial: SERIAL,
})

const FIND_H2 = find({
  ip: 'On the touchscreen, open Settings, then LAN Only. The IP address is shown there.',
  credential: `Open the same LAN Only page. ${CODE} ${REACH} ${LIVEVIEW} ${DIRECT('H2D firmware 01.01.00.01')}`,
  serial: SERIAL,
})

const FIND_P1 = find({
  ip: 'On the printer screen, open Settings, then WLAN. The IP address is shown there.',
  credential: `The access code (8 characters) is on the WLAN page. If the printer later refuses it, read it again there. If the printer can't be reached, open LAN Only Mode on that page and choose Yes. Optional, for printing directly: with LAN Only Mode on, scroll down the WLAN page to Developer Mode (firmware 01.08.02.00 and later), read the notice to the end and choose Enable. Without it, prints go through Bambu Connect, where you press Print.`,
  serial: SERIAL,
})

const FIND_A1 = find({
  ip: 'On the touchscreen, open Settings, then WLAN. The IP address is shown there.',
  credential: `Open Settings, swipe to page 3 and tap LAN Only Mode. ${CODE} ${REACH} ${DIRECT('firmware 01.05.00.00')}`,
  serial: SERIAL,
})

const STD = [0.2, 0.4, 0.6, 0.8]
const bambu = (m: Omit<PrinterModel, 'brand' | 'connections' | 'nozzleCount' | 'defaultNozzle' | 'find'> & Partial<PrinterModel>): PrinterModel => ({
  brand: 'bambu-lab',
  connections: ['bambu-lan', 'bambuddy', 'export'],
  nozzleCount: 1,
  defaultNozzle: 0.4,
  find: FIND_X1,
  ...m,
})

export const BAMBU: PrinterModel[] = [
  bambu({
    id: 'bambu-x1-carbon',
    name: 'X1 Carbon',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(256, 256, 256),
    nozzles: STD,
    filamentSystem: 'ams',
  }),
  bambu({ id: 'bambu-x1', name: 'X1', kinematics: 'corexy', enclosed: true, buildVolume: rect(256, 256, 256), nozzles: STD, filamentSystem: 'ams' }),
  bambu({ id: 'bambu-x1e', name: 'X1E', kinematics: 'corexy', enclosed: true, buildVolume: rect(256, 256, 256), nozzles: STD, filamentSystem: 'ams' }),
  bambu({ id: 'bambu-p1p', find: FIND_P1, name: 'P1P', kinematics: 'corexy', enclosed: false, buildVolume: rect(256, 256, 256), nozzles: STD, filamentSystem: 'ams' }),
  bambu({
    id: 'bambu-p1s',
    find: FIND_P1,
    name: 'P1S',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(256, 256, 256),
    nozzles: STD,
    filamentSystem: 'ams',
  }),
  bambu({ id: 'bambu-p2s', name: 'P2S', kinematics: 'corexy', enclosed: true, buildVolume: rect(256, 256, 256), nozzles: STD, filamentSystem: 'ams', find: FIND_H2 }),
  bambu({
    id: 'bambu-a1',
    find: FIND_A1,
    name: 'A1',
    kinematics: 'bed-slinger',
    enclosed: false,
    buildVolume: rect(256, 256, 256),
    nozzles: STD,
    filamentSystem: 'ams',
    filamentUnit: 'AMS lite',
  }),
  bambu({ id: 'bambu-a1-mini', find: FIND_A1, name: 'A1 mini', kinematics: 'bed-slinger', enclosed: false, buildVolume: rect(180, 180, 180), nozzles: STD, filamentSystem: 'ams', filamentUnit: 'AMS lite' }),
  bambu({
    id: 'bambu-h2d',
    name: 'H2D',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(350, 320, 325),
    nozzles: STD,
    nozzleCount: 2,
    filamentSystem: 'ams',
    find: FIND_H2,
    note: 'Two nozzles on one carriage. The build volume is the area both nozzles reach.',
  }),
  bambu({
    id: 'bambu-h2c',
    name: 'H2C',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(330, 320, 325),
    nozzles: STD,
    nozzleCount: 2,
    filamentSystem: 'ams',
    find: FIND_H2,
    note: 'One printing nozzle plus a rack of swappable nozzles. The build volume is the area both nozzle positions reach.',
  }),
  bambu({
    id: 'bambu-h2s',
    name: 'H2S',
    kinematics: 'corexy',
    enclosed: true,
    buildVolume: rect(340, 320, 340),
    nozzles: STD,
    filamentSystem: 'ams',
    find: FIND_H2,
  }),
]
