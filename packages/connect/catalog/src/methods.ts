// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ConnectionField, ConnectionId, ConnectionMethod } from './types.ts'

const host: ConnectionField = { key: 'host', label: 'IP address', secret: false, required: true, placeholder: '192.168.1.50' }
const port = (placeholder: string): ConnectionField => ({ key: 'port', label: 'Port', secret: false, required: false, placeholder })
const apiKey = (required: boolean): ConnectionField => ({ key: 'apiKey', label: 'API key', secret: true, required })

export const CONNECTION_METHODS: readonly ConnectionMethod[] = [
  {
    id: 'bambu-lan',
    startOptions: ['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse', 'firstLayerInspection'],
    name: 'Bambu Lab LAN',
    plugin: 'bambu-lan',
    guide: 'bambu-lan.md',
    defaultPort: 8883,
    discovery: {
      kind: 'ssdp',
      detail: 'Sends one SSDP search on UDP 2021 and 1990 and listens for the answers and announcements of Bambu Lab printers.',
    },
    fields: [
      host,
      { key: 'serial', label: 'Serial number', secret: false, required: false, placeholder: 'Read from the printer when empty' },
      { key: 'accessCode', label: 'Access code', secret: true, required: true, placeholder: '8 characters' },
    ],
    summary: 'Enter the access code from the printer\'s LAN Only page. A scan fills in the IP address and serial number; with an IP address alone, SlicerX reads the serial number from the printer. Developer Mode is optional: with it, prints go straight from SlicerX; without it, they go through Bambu Connect.',
  },
  {
    id: 'moonraker',
    startOptions: [],
    name: 'Moonraker (Klipper)',
    plugin: 'moonraker',
    guide: 'moonraker.md',
    defaultPort: 7125,
    discovery: {
      kind: 'mdns',
      service: '_moonraker._tcp',
      detail: 'Asks the network for Moonraker servers with one multicast DNS query. An IP address alone is checked on ports 7125 and 80.',
    },
    fields: [
      host,
      port('7125'),
      apiKey(false),
      { key: 'username', label: 'User name', secret: false, required: false, placeholder: 'Only if logins are required' },
      { key: 'password', label: 'Password', secret: true, required: false },
    ],
    summary: 'Any Klipper printer that opens in Mainsail or Fluidd. An API key is needed only if your computer is not a trusted client; a printer that requires logins also takes its user name and password.',
  },
  {
    id: 'octoprint',
    startOptions: [],
    name: 'OctoPrint',
    plugin: 'octoprint',
    guide: 'octoprint.md',
    defaultPort: 5000,
    discovery: {
      kind: 'mdns',
      service: '_octoprint._tcp',
      detail: 'Asks the network for OctoPrint servers with one multicast DNS query.',
    },
    fields: [host, port('80 on OctoPi, 5000 otherwise'), apiKey(true)],
    summary: 'A Raspberry Pi running OctoPrint in front of the printer, with an application key.',
  },
  {
    id: 'prusalink',
    startOptions: [],
    name: 'PrusaLink',
    plugin: 'prusalink',
    guide: 'prusalink.md',
    defaultPort: 80,
    discovery: {
      kind: 'mdns',
      service: '_prusalink._tcp',
      detail: 'Asks the network for PrusaLink with a multicast DNS query. Not seen on a printer yet, so a scan may miss it.',
    },
    fields: [
      host,
      { key: 'password', label: 'Password', secret: true, required: true, placeholder: 'Shown in Settings > Network > PrusaLink' },
      { key: 'username', label: 'User name', secret: false, required: false, placeholder: 'maker' },
    ],
    summary: 'Prusa printers with PrusaLink. Enter the password the printer shows; the user name is maker. An API key from older firmware goes in the same field.',
  },
  {
    id: 'duet',
    startOptions: [],
    name: 'Duet (RepRapFirmware)',
    plugin: 'duet',
    guide: 'duet.md',
    defaultPort: 80,
    discovery: { kind: 'manual', detail: 'Duet boards are not found automatically. Enter the address or the board\'s .local name.' },
    fields: [host, { key: 'password', label: 'Password', secret: true, required: false, placeholder: 'reprap if none was set' }],
    summary: 'Duet 2 and Duet 3 boards with RepRapFirmware 3. A password is needed only if you set one.',
  },
  {
    id: 'creality',
    startOptions: [],
    name: 'Creality',
    plugin: 'creality',
    guide: 'creality.md',
    defaultPort: 9999,
    discovery: {
      kind: 'mdns',
      service: '_Creality-<id>._udp',
      detail: 'Asks the network which services it offers with one multicast DNS query, and lists the ones stock Creality firmware announces. An IP address alone is checked through the printer\'s /info page and port 9999.',
    },
    fields: [host, apiKey(false)],
    summary: 'No code or password. SlicerX checks whether the printer answers as Moonraker or with Creality\'s own interface.',
  },
  {
    id: 'snapmaker',
    startOptions: [],
    name: 'Snapmaker',
    plugin: 'snapmaker',
    guide: 'snapmaker.md',
    defaultPort: 8080,
    discovery: {
      kind: 'udp-broadcast',
      detail: 'Sends one UDP broadcast on port 20054 when you start a scan; the A150, A250, A350, J1 and Artisan answer it. Never runs in the background.',
    },
    fields: [host, { key: 'pairing', label: 'Pair on the touchscreen', secret: true, required: false }],
    pairsOnPrinter: true,
    summary: 'The U1 needs only its address. Snapmaker 2.0 machines ask you to confirm on their touchscreen once.',
  },
  {
    id: 'elegoo',
    startOptions: ['bedLeveling', 'timelapse'],
    name: 'Elegoo Centauri Carbon',
    plugin: 'elegoo',
    guide: 'elegoo.md',
    defaultPort: 3030,
    discovery: {
      kind: 'udp-broadcast',
      detail: 'Sends one UDP broadcast on port 3000 when you start a scan. Never runs in the background.',
    },
    fields: [host],
    summary: 'No code or password. Elegoo printers that run Klipper use the Moonraker connection instead.',
  },
  {
    id: 'ultimaker',
    startOptions: [],
    name: 'UltiMaker',
    plugin: 'ultimaker',
    guide: 'ultimaker.md',
    defaultPort: 80,
    discovery: {
      kind: 'mdns',
      service: '_ultimaker._tcp',
      detail: 'Asks the network for UltiMaker printers with one multicast DNS query, as UltiMaker Cura does.',
    },
    fields: [host],
    summary: 'UltiMaker S series and UM3 printers with firmware 4.0 or later. No code or password: jobs go through the printer\'s local cluster API. Experimental, untested on hardware.',
  },
  {
    id: 'anycubic',
    startOptions: [],
    name: 'Anycubic LAN Mode',
    plugin: 'anycubic',
    guide: 'anycubic.md',
    defaultPort: 18910,
    discovery: {
      kind: 'manual',
      detail: 'Anycubic printers are not known to announce themselves in LAN Mode. Enter the IP address; SlicerX asks it on port 18910 for its model and whether LAN Mode is on.',
    },
    fields: [host],
    summary: 'Experimental, untested on a printer. Turn on LAN Mode on the printer first: that removes it from your Anycubic account for good. No code or password.',
  },
  {
    id: 'bambuddy',
    startOptions: ['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse', 'firstLayerInspection'],
    name: 'BamBuddy',
    plugin: 'bambuddy',
    guide: 'bambuddy.md',
    defaultPort: 8000,
    requiresApp: 'bambuddy',
    discovery: {
      kind: 'manual',
      detail: 'BamBuddy is not scanned. Its address and API key come from Settings, Connected apps; enter the printer number BamBuddy uses.',
    },
    fields: [{ key: 'serial', label: 'BamBuddy printer id', secret: false, required: true, placeholder: '12' }],
    summary: 'Prints go through the BamBuddy you added in Connected apps. Enter the number BamBuddy uses for this printer. That number is the link, including a printer BamBuddy reaches through a bridge.',
  },
  {
    id: 'export',
    startOptions: [],
    name: 'Save G-code',
    plugin: null,
    guide: 'export.md',
    discovery: { kind: 'manual', detail: 'No connection. Slice, save the file, and carry it to the printer on USB or an SD card.' },
    fields: [],
    summary: 'For printers SlicerX cannot talk to yet. Save the file and copy it over.',
  },
]

const BY_ID = new Map<ConnectionId, ConnectionMethod>(CONNECTION_METHODS.map((m) => [m.id, m]))

export function connectionMethod(id: ConnectionId): ConnectionMethod {
  const m = BY_ID.get(id)
  if (!m) throw new Error(`unknown connection method ${id}`)
  return m
}
