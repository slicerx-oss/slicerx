// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir.run over the app link: the chat's print run read back live from the tab's runtime (so a print going shows its
// layer, progress and time left), else from the last print_run event in its session log, step by step, with the slice,
// the send and the print under the names the app shows. The file, its SHA-256, approval
// tokens, request ids, access codes and serials stay in the app, and nothing on the link approves a print.
import type { PilotEvent, PrinterEvent, PrinterHost, PrintRun } from '@slicerx/contracts'
import { createMemorySessionStore, createRunBook } from '@slicerx/pilot'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { bindRunPrinters } from '../src/app-link/mimir-run'
import { setSessionSource, setTabChat } from '../src/app-link/sessions'

// A Bambu Lab printer goes by its serial as its id; only the name the person gave it may leave the app.
const SERIAL = '01P00A451200789'
const SHA = 'f'.repeat(64)
const PRINTERS = {
  list: async () => [{ id: SERIAL, name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1, host: '192.168.1.42' }],
} as unknown as PrinterHost

const start = (sessionId: string, at: string): PilotEvent => ({ type: 'start', runId: `r${at}`, sessionId, provider: 'scripted', model: 'scripted', at })

function runOf(sessionId: string, patch: Partial<PrintRun> = {}): PrintRun {
  return { sessionId, designId: 'design_1', plate: 1, printerId: SERIAL, slots: { 2: 'A3', 1: 'A2' }, slice: null, send: null, job: null, updatedAt: '2026-10-19T10:00:00Z', ...patch }
}

const SLICE = { sliceId: 'slice_9', plate: 1, at: '2026-10-19T10:01:00Z', timeS: 3720, grams: 41.5, cost: 0.83, warnings: ['Thin wall on the clip'], fingerprint: 'fp_1', stale: false }
const SEND = { printerId: SERIAL, fileName: 'Bracket_plate_1.gcode.3mf', fileKind: 'gcode.3mf' as const, sha256: SHA, slots: { 1: 'A2', 2: 'A3' }, timeS: 3720, grams: 41.5 }
const JOB = { printerId: SERIAL, fileName: 'Bracket_plate_1.gcode.3mf', startedAt: '2026-10-19T10:03:00Z', state: 'printing' as const, layer: 12, layerCount: 140, timeLeftS: 3100, progress: 9 }

async function logOf(sessions: Record<string, PilotEvent[]>) {
  const s = createMemorySessionStore()
  for (const [id, events] of Object.entries(sessions)) for (const e of events) await s.append(id, e)
  return s
}

afterEach(() => {
  setSessionSource(null)
  setTabChat(null)
  bindRunPrinters(undefined)
})

describe('mimir.run over the app link', () => {
  it('reads with the read class, and answers null before the tab first opens', async () => {
    expect(APP_LINK_METHODS['mimir.run']).toBe('read')
    expect(await runCall('mimir.run', {})).toBeNull()
  })

  it('read-back follows the run', async () => {
    bindRunPrinters({ printers: PRINTERS })
    const events: PilotEvent[] = [start('mimir_a', '2026-10-19T10:00:00Z'), { type: 'print_run', run: runOf('mimir_a', { slice: SLICE }) }]
    setSessionSource({ store: await logOf({ mimir_a: events }) })
    expect(await runCall('mimir.run', {})).toEqual({
      sessionId: 'mimir_a',
      steps: [
        { name: 'design', state: 'done' },
        { name: 'plate', state: 'done' },
        { name: 'target', state: 'done' },
        { name: 'slice', state: 'done' },
        { name: 'send', state: 'now' },
        { name: 'print', state: 'todo' },
      ],
      slice: { timeS: 3720, grams: 41.5, cost: 0.83, warnings: ['Thin wall on the clip'], stale: false },
      send: null,
      print: null,
    })

    // later events win: the send and the print as the printer last reported it
    events.push({ type: 'run_note', text: 'Started on Bay 2', tone: 'ok' }, { type: 'print_run', run: runOf('mimir_a', { slice: SLICE, send: SEND, job: JOB }) })
    setSessionSource({ store: await logOf({ mimir_a: events }) })
    const sent = (await runCall('mimir.run', {})) as Record<string, unknown>
    expect(sent['send']).toEqual({ printerName: 'Bay 2', fileName: 'Bracket_plate_1.gcode.3mf', slots: [{ filament: 1, slot: 'A2' }, { filament: 2, slot: 'A3' }] })
    expect(sent['print']).toEqual({ printerName: 'Bay 2', state: 'printing', layer: 12, layerCount: 140, timeLeftS: 3100, progress: 9, outcome: null })
    expect((sent['steps'] as { state: string }[]).map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'now'])

    // a finished print ends the run; a stale slice shows as one
    events.push({ type: 'print_run', run: runOf('mimir_a', { slice: { ...SLICE, stale: true }, send: SEND, job: { ...JOB, state: 'finished', layer: 140, timeLeftS: 0, progress: 100, outcome: 'finished', endedAt: '2026-10-19T11:05:00Z' } }) })
    setSessionSource({ store: await logOf({ mimir_a: events }) })
    const done = (await runCall('mimir.run', {})) as Record<string, { outcome?: unknown; stale?: unknown }>
    expect(done['print']?.outcome).toBe('finished')
    expect(done['slice']?.stale).toBe(true)

    // a chat with no print run yet: every step still to do, nothing sliced, sent or printing
    setSessionSource({ store: await logOf({ mimir_b: [start('mimir_b', '2026-10-19T12:00:00Z')] }) })
    expect(await runCall('mimir.run', {})).toEqual({
      sessionId: 'mimir_b',
      steps: [
        { name: 'design', state: 'now' },
        { name: 'plate', state: 'todo' },
        { name: 'target', state: 'todo' },
        { name: 'slice', state: 'todo' },
        { name: 'send', state: 'todo' },
        { name: 'print', state: 'todo' },
      ],
      slice: null,
      send: null,
      print: null,
    })
  })

  it('a print going reads live: its layer, progress and time left mid print', async () => {
    bindRunPrinters({ printers: PRINTERS })
    // the tab's runtime watching the started print through the printer's status events
    const subs = new Set<(e: PrinterEvent) => void>()
    const subscribe = (_id: string, fn: (e: PrinterEvent) => void) => {
      subs.add(fn)
      return () => void subs.delete(fn)
    }
    const watched = { list: PRINTERS.list, subscribe } as unknown as PrinterHost
    const log: PilotEvent[] = [start('mimir_a', '2026-10-19T10:00:00Z')]
    const runs = createRunBook({ fingerprint: () => 'fp_1' }, () => Date.parse('2026-10-19T10:30:00Z'), { printers: watched, log: (_id, e) => void log.push(e) })
    runs.update('mimir_a', { designId: 'design_1', printerId: SERIAL, slots: { 1: 'A2' }, slice: SLICE })
    runs.recordSend('mimir_a', SEND)
    const begun = { printerId: SERIAL, fileName: JOB.fileName, startedAt: JOB.startedAt, state: 'printing' as const }
    runs.recordJob('mimir_a', begun)
    // the log has the print as it started, and nothing of its progress
    log.push({ type: 'print_run', run: runs.get('mimir_a') })
    const status = (layer: number, progress: number, timeLeftS: number): PrinterEvent => ({ type: 'status', status: { printerId: SERIAL, state: 'printing', layer, layerCount: 180, progress, timeLeftS, nozzles: [], slots: [], cameraAvailable: false, updatedAt: '' } })
    for (const fn of subs) fn(status(42, 0.23, 2400))
    setSessionSource({ store: await logOf({ mimir_a: log }), run: (id) => runs.get(id) })
    expect(((await runCall('mimir.run', {})) as Record<string, unknown>)['print']).toEqual({ printerName: 'Bay 2', state: 'printing', layer: 42, layerCount: 180, timeLeftS: 2400, progress: 23, outcome: null })
    for (const fn of subs) fn(status(43, 0.24, 2340))
    expect(((await runCall('mimir.run', { sessionId: 'mimir_a' })) as Record<string, unknown>)['print']).toMatchObject({ layer: 43, progress: 24, timeLeftS: 2340 })
    // a runtime that holds nothing for the chat (a new chat dropped it) reads the log as it last had it
    setSessionSource({ store: await logOf({ mimir_a: log }), run: (id) => runs.get(`${id}_other`) })
    expect(((await runCall('mimir.run', {})) as Record<string, unknown>)['print']).toMatchObject({ state: 'printing', layer: null, progress: null })
  })

  it('sessionId picks that chat', async () => {
    bindRunPrinters({ printers: PRINTERS })
    setSessionSource({
      store: await logOf({
        mimir_a: [start('mimir_a', '2026-10-19T10:00:00Z'), { type: 'print_run', run: runOf('mimir_a', { slice: SLICE, send: SEND, job: JOB }) }],
        mimir_b: [start('mimir_b', '2026-10-19T12:00:00Z'), { type: 'print_run', run: runOf('mimir_b', { printerId: null, slots: {} }) }],
      }),
    })
    // with no sessionId, the newest mimir session
    const newest = (await runCall('mimir.run', {})) as { sessionId: string; print: unknown }
    expect(newest.sessionId).toBe('mimir_b')
    expect(newest.print).toBeNull()
    const a = (await runCall('mimir.run', { sessionId: 'mimir_a' })) as { sessionId: string; print: { state: string } }
    expect(a.sessionId).toBe('mimir_a')
    expect(a.print.state).toBe('printing')
    expect(((await runCall('mimir.run', { sessionId: 'mimir_x' }).catch((e: unknown) => e)) as LinkError).code).toBe('not_found')
    for (const bad of [42, '', 'x'.repeat(201)]) expect(((await runCall('mimir.run', { sessionId: bad }).catch((e: unknown) => e)) as LinkError).code).toBe('invalid_input')
  })

  it("with no sessionId, the tab's current chat, else the newest", async () => {
    bindRunPrinters({ printers: PRINTERS })
    setSessionSource({
      store: await logOf({
        mimir_a: [start('mimir_a', '2026-10-19T10:00:00Z'), { type: 'print_run', run: runOf('mimir_a', { slice: SLICE, send: SEND, job: JOB }) }],
        mimir_b: [start('mimir_b', '2026-10-19T12:00:00Z'), { type: 'print_run', run: runOf('mimir_b', { printerId: null, slots: {} }) }],
      }),
    })
    // the chat the tab has open, though a newer one is in the log
    setTabChat('mimir_a')
    const open = (await runCall('mimir.run', {})) as { sessionId: string; print: { state: string } | null }
    expect(open.sessionId).toBe('mimir_a')
    expect(open.print?.state).toBe('printing')
    // a new chat with nothing said yet has no run: it is not the last chat's
    setTabChat('mimir_new')
    expect(await runCall('mimir.run', {})).toMatchObject({ sessionId: 'mimir_new', slice: null, send: null, print: null })
    // sessionId still names any chat
    expect(((await runCall('mimir.run', { sessionId: 'mimir_b' })) as { sessionId: string }).sessionId).toBe('mimir_b')
    // a tab that has never opened leaves the newest
    setTabChat(null)
    expect(((await runCall('mimir.run', {})) as { sessionId: string }).sessionId).toBe('mimir_b')
  })

  it('no sha256, request id or token leaves the app', async () => {
    bindRunPrinters({ printers: PRINTERS })
    // a run record that carries more than its type: the file bytes, the token and request of its card, the access code
    const leaky = {
      ...runOf('mimir_a', { slice: SLICE, send: SEND, job: JOB }),
      requestId: 'req_7f3a',
      token: 'tok_secret_123',
      accessCode: '12345678',
    } as PrintRun
    const send = { ...SEND, data: 'UEsDBBQAAAAIAAAAIQ', requestId: 'req_7f3a', token: 'tok_secret_123', approvalToken: 'tok_secret_123' }
    const job = { ...JOB, serial: SERIAL, accessCode: '12345678', requestId: 'req_7f3a' }
    setSessionSource({ store: await logOf({ mimir_a: [start('mimir_a', '2026-10-19T10:00:00Z'), { type: 'print_run', run: { ...leaky, send, job } as PrintRun }] }) })
    const all = JSON.stringify(await runCall('mimir.run', {}))
    for (const secret of [SHA, SERIAL, 'req_7f3a', 'tok_secret_123', '12345678', 'UEsDBBQ', '192.168.1.42', 'sha256', 'fingerprint', 'sliceId', 'printerId', 'token', 'requestId', 'accessCode', 'serial']) {
      expect(all, secret).not.toContain(secret)
    }
    // a printer the app no longer knows reads with no name, never its id
    bindRunPrinters(undefined)
    expect(JSON.stringify(await runCall('mimir.run', {}))).not.toContain(SERIAL)
  })

  it("an integrator's printer.queue still waits for the person", async () => {
    // Nothing on the app link approves, grants, queues, starts or sends: a print an integrator asks for goes to the
    // hub with its card, and only the person's click in the app answers it.
    for (const m of Object.keys(APP_LINK_METHODS)) expect(m, m).not.toMatch(/approv|grant|queue|start|upload|send|answer|print\b|printer\./i)
    for (const m of ['mimir.approve', 'mimir.run_approve', 'approvals.grant', 'printer.queue', 'printer.start']) {
      expect(((await runCall(m, {}).catch((e: unknown) => e)) as LinkError).code, m).toBe('not_found')
    }
  })
})
