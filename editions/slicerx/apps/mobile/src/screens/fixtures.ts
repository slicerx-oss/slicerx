// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Example data for screen tests and for screens whose clients are not wired yet. Fictional
// studios, neutral models, documentation-range addresses.
import type { Fleet, PilotEvent, SessionSummary } from '@slicerx/contracts'
import type { PrinterView } from '../components/printers/printer-bits'
import type { LibraryEntry } from './library-screen'
import type { AppNotification } from './notifications-screen'
import type { JoinRequestView, PairedHostView } from './pairing-screen'
import type { ModelChoice } from './send-print-screen'

/** 2026-09-30 14:05 local. Tests pass it as `now`. */
export const NOW = new Date(2026, 8, 30, 14, 5).getTime()
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

export const PRINTERS: PrinterView[] = [
  {
    info: { id: 'bay-1', name: 'Bay 1', vendor: 'Bambu Lab', model: 'X1 Carbon', plugin: 'bambu-lan', host: '192.0.2.11', nozzleCount: 1, filamentSystem: 'ams' },
    status: {
      printerId: 'bay-1',
      state: 'printing',
      jobName: 'Tidewell harbor lantern.gcode.3mf',
      progress: 0.62,
      layer: 148,
      layerCount: 238,
      timeLeftS: 5040,
      nozzles: [{ current: 249.6, target: 250 }],
      bed: { current: 79.8, target: 80 },
      chamber: { current: 38, target: 0 },
      slots: [
        { id: 'A1', material: 'PLA', color: '#f2f2f2', remainingPct: 82 },
        { id: 'A2', material: 'PETG', color: '#3b82f6', remainingPct: 41 },
      ],
      cameraAvailable: true,
      updatedAt: at(0),
    },
  },
  {
    info: { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', host: '192.0.2.12', nozzleCount: 1, filamentSystem: 'ams' },
    status: { printerId: 'bay-2', state: 'idle', nozzles: [{ current: 27, target: 0 }], bed: { current: 26, target: 0 }, slots: [], cameraAvailable: true, updatedAt: at(0) },
  },
  {
    info: { id: 'bay-3', name: 'Bay 3', vendor: 'Prusa Research', model: 'MK4S', plugin: 'prusalink', host: '192.0.2.13', nozzleCount: 1 },
    status: {
      printerId: 'bay-3',
      state: 'paused',
      jobName: 'Kestrel Parts bracket set.bgcode',
      progress: 0.41,
      layer: 88,
      layerCount: 214,
      timeLeftS: 11_100,
      nozzles: [{ current: 170, target: 215 }],
      bed: { current: 60, target: 60 },
      slots: [],
      cameraAvailable: false,
      message: 'Filament change requested',
      updatedAt: at(1),
    },
  },
  {
    info: { id: 'bay-5', name: 'Bay 5', vendor: 'Creality', model: 'K1 Max', plugin: 'creality', host: '192.0.2.15', nozzleCount: 1 },
    status: { printerId: 'bay-5', state: 'offline', nozzles: [{ current: 0, target: 0 }], slots: [], cameraAvailable: true, message: 'Last seen 2 h ago', updatedAt: at(120) },
  },
]

export const FLEETS: Fleet[] = [{ id: 'workshop', name: 'Workshop', printerIds: ['bay-1', 'bay-2', 'bay-3'] }]

export const LIBRARY: LibraryEntry[] = [
  { id: 'm1', slug: 'hex-planter', name: 'Hex planter', format: '3mf', tags: ['home', 'planter'], creator: 'Northfield Makers' },
  { id: 'm2', slug: 'cable-clip-set', name: 'Cable clip set', format: 'stl', tags: ['desk', 'organizer'] },
  { id: 'm3', slug: 'harbor-lantern', name: 'Harbor lantern', format: 'sx3mf', tags: ['home', 'lamp'], creator: 'Tidewell Studio' },
]

export const MODEL_CHOICES: ModelChoice[] = LIBRARY.map((e) => ({ id: e.id, name: e.name, source: 'library', detail: e.format.toUpperCase() }))

export const SESSIONS: SessionSummary[] = [
  { id: 's1', title: 'Plan 12 cable clips in PETG', status: 'done', startedAt: at(3) },
  { id: 's2', title: 'Why did Bay 3 pause?', status: 'stopped', startedAt: at(60 * 26) },
]

const RIGHTS = { request: true, approve: true, introduce: true }

export const HOSTS: PairedHostView[] = [
  {
    host: { pairingId: 'p1', hostId: 'h1', name: 'Studio Mac', platform: 'desktop', rights: RIGHTS, endpoints: { lan: ['ws://192.0.2.20:7450'] }, createdAt: NOW - 30 * 86_400_000, lastSeenAt: NOW, accountLinked: true, pendingIntroduction: false },
    online: true,
    slicing: ['host', 'cloud'],
  },
  {
    host: { pairingId: 'p2', hostId: 'h2', name: 'Workshop browser', platform: 'web', rights: RIGHTS, endpoints: { lan: [] }, createdAt: NOW - 9 * 86_400_000, lastSeenAt: NOW - 30 * 3_600_000, accountLinked: false, pendingIntroduction: false },
    online: false,
    slicing: [],
  },
]

export const JOIN_REQUESTS: JoinRequestView[] = [{ requestId: 'j1', name: 'Riley tablet', platform: 'android', canReview: true }]

export const NOTIFICATIONS: AppNotification[] = [
  { id: 'n1', kind: 'approval', title: 'mimir is waiting for you', body: 'Send 2 plates to Bay 2 and Bay 3?', at: at(2), read: false },
  { id: 'n2', kind: 'attention', title: 'Bay 3 paused', body: 'Filament change requested at layer 88', at: at(40), read: false },
  { id: 'n3', kind: 'print_done', title: 'Bay 4 finished', body: 'Ferro Labs duct adapter, 3h 12m', at: at(60 * 20), read: true },
]

/** One mimir run up to an approval card, as the runtime streams it. */
export const RUN_EVENTS: PilotEvent[] = [
  { type: 'start', runId: 'r1', sessionId: 's1', provider: 'example', model: 'example-model', at: at(1) },
  { type: 'thinking', delta: 'Twelve clips fit on one plate. Check which idle printer has PETG loaded.' },
  { type: 'thinking_done', ms: 2400 },
  { type: 'tool_call', callId: 'c1', tool: 'bambu.lan.status', source: 'plugin', input: { printer: 'bay-2' }, args: 'bay-2' },
  {
    type: 'tool_result',
    callId: 'c1',
    ok: true,
    summary: 'Bay 2 idle, PETG in slot A3',
    ms: 600,
    display: [{ kind: 'kv', rows: [['state', { text: 'idle, bed clear', tone: 'ok' }], ['nozzle', '0.4 mm hardened steel']] }],
  },
  { type: 'text', delta: 'Bay 2 is idle with **PETG** loaded. ' },
  { type: 'text', delta: 'I sliced one plate: 1h 52m and 38.4 g.' },
  { type: 'text_done' },
  {
    type: 'approval_request',
    request: {
      id: 'a1',
      sessionId: 's1',
      tool: 'bambu.lan.queue',
      permission: 'queue',
      title: 'Send 1 plate to Bay 2?',
      lines: ['12 cable clips on Bay 2 (P1S), 1h 52m', 'Starts at 14:07 and finishes by 15:59'],
      printerId: 'bay-2',
      paramsHash: 'x',
      actions: [],
      expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    },
  },
]
