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
      { key: 'serial', label: 'Serial number', secret: false, required: true },
      { key: 'accessCode', label: 'Access code', secret: true, required: true, placeholder: '8 characters' },
    ],
    summary: 'Turn on LAN Only Mode and Developer Mode on the printer, then enter its access code. A scan fills in the IP address and serial number.',
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
      detail: 'Asks the network for Moonraker servers with one multicast DNS query.',
    },
    fields: [host, port('7125'), apiKey(false)],
    summary: 'Any Klipper printer that opens in Mainsail or Fluidd. An API key is needed only if your computer is not a trusted client.',
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
      apiKey(false),
      { key: 'username', label: 'User name', secret: false, required: false, placeholder: 'maker' },
      { key: 'password', label: 'Password', secret: true, required: false },
    ],
    summary: 'Prusa printers with PrusaLink. Enter the API key, or the user name and password the printer shows.',
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
    discovery: { kind: 'manual', detail: 'Creality printers on stock firmware are not found automatically. Enter the IP address.' },
    fields: [host],
    summary: 'No code or password. SlicerX checks whether the printer answers as Moonraker or with Creality\'s own interface.',
  },
  {
    id: 'snapmaker',
    startOptions: [],
    name: 'Snapmaker',
    plugin: 'snapmaker',
    guide: 'snapmaker.md',
    defaultPort: 8080,
    discovery: { kind: 'manual', detail: 'Snapmaker machines are not found automatically. Enter the IP address.' },
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
