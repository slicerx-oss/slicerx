// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads the print watch's per-printer settings through the hub the way it reads any printer, and cannot change
// them: auto-pause, huginn, the bed mask and the camera guard are set by the person in the app, and the hub refuses those
// calls from an agent. The hub is a scripted stand-in that answers settings.get, watch.huginnPrinters, watch.masks and
// watch.guardState as sx-link does.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { AGENT_CODE, scriptedLinkHub, type HubHandler } from './helpers/scripted-hub'
import type { PrintWatchRow } from '../src/toolbox/print-watch-status'

const PRINTERS = [
  { id: 'bay-4', name: 'Bay 4', vendor: 'Voron Design', model: 'Voron 2.4 350', plugin: 'moonraker', nozzleCount: 1 },
  { id: 'a1', name: 'A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu', nozzleCount: 1 },
  { id: 'sm2', name: 'Snapmaker', vendor: 'Snapmaker', model: 'A350', plugin: 'snapmaker', nozzleCount: 1 },
]
const status = (printerId: string, state: string, cameraAvailable: boolean) => ({ printerId, state, nozzles: [{ current: 30, target: 0 }], bed: { current: 25, target: 0 }, slots: [], cameraAvailable, updatedAt: '2026-11-03T08:00:00.000Z' })
const STATUS: Record<string, ReturnType<typeof status>> = { 'bay-4': status('bay-4', 'printing', true), a1: status('a1', 'idle', true), sm2: status('sm2', 'printing', false) }

/** The methods an agent connection is refused (sx-link roles.rs APP_ONLY), as far as the print watch goes. `watch.guardState` is not one. */
const APP_ONLY = ['watch.autoPause', 'watch.huginn', 'watch.mask', 'watch.dismiss', 'watch.guard', 'watch.evidence', 'watch.resume', 'watch.plateClear', 'watch.plateCheck', 'watch.plateIgnore', 'watch.handCheck', 'settings.set']

/** sx-link's `watch.guardState`: a hand paused bay-4, the guard is off for the Snapmaker, and the A1 has an empty-plate picture. */
const GUARD = {
  trips: {
    'bay-4': { printerId: 'bay-4', kind: 'hand', state: 'paused', at: '2026-11-03T08:01:00.000Z', box: [0.2, 0.3, 0.5, 0.9], note: '2 of the last 3 frames', confidence: 0.85, monitorOnly: false, capturedAt: '2026-11-03T08:00:59.000Z', answered: false, trippedMs: 1793692860000 },
  },
  off: ['sm2'],
  plates: { a1: '2026-11-03T07:30:00.000Z' },
  detector: true,
}

function hub(over: Partial<Record<string, HubHandler>> = {}) {
  const answers: Record<string, HubHandler> = {
    list: () => PRINTERS,
    status: (_m, p) => STATUS[String(p['printerId'])] ?? Promise.reject({ code: 'not_found', message: 'no printer' }),
    'settings.get': () => ({ experimentalConnectors: false, appLink: false, watchAutoPausePrinters: ['bay-4', 'a1'], watchMasks: {} }),
    'watch.huginnPrinters': () => ['bay-4'],
    'watch.masks': () => ({ a1: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]] }),
    'watch.guardState': () => GUARD,
    ...over,
  }
  return scriptedLinkHub((method, params) => {
    if (APP_ONLY.includes(method)) throw { code: 'forbidden', message: `${method} is for the app` }
    const a = answers[method]
    return a ? a(method, params) : {}
  })
}

const link = (h: ReturnType<typeof hub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: AGENT_CODE, linkWebSocket: h.WS })
type Answer = Awaited<ReturnType<Awaited<ReturnType<typeof connect>>['call']>>
const rows = (r: Answer) => data<{ printers: PrintWatchRow[] }>(r).printers
const detector = (r: Answer) => data<{ detector: boolean | null }>(r).detector

describe('slicerx_print_watch_status', () => {
  it('is a read-only printer tool with one optional argument', async () => {
    const { client } = await connect({ printers: 'demo' })
    const tool = (await client.listTools()).tools.find((t) => t.name === 'slicerx_print_watch_status')
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.annotations?.destructiveHint).toBe(false)
    const schema = tool?.inputSchema as { properties: object; required?: string[] }
    expect(Object.keys(schema.properties)).toEqual(['printerId'])
    expect(schema.required ?? []).toEqual([])
  })

  it("reads every printer's auto-pause, huginn, bed mask and camera guard through the hub, and whether it is watched now", async () => {
    const h0 = hub()
    const h = await connect(link(h0))
    const r = await h.call('slicerx_print_watch_status', {})
    expect(r.isError, text(r)).toBeFalsy()
    expect(rows(r)).toEqual([
      {
        printerId: 'bay-4',
        name: 'Bay 4',
        state: 'printing',
        camera: 'can_watch',
        watchedNow: true,
        autoPause: true,
        huginn: true,
        pausesOnFailure: true,
        bedMask: false,
        guard: true,
        // The trip as the hub has it, without the printer id and the hub's own trippedMs.
        guardTrip: { kind: 'hand', state: 'paused', at: '2026-11-03T08:01:00.000Z', box: [0.2, 0.3, 0.5, 0.9], note: '2 of the last 3 frames', confidence: 0.85, monitorOnly: false, capturedAt: '2026-11-03T08:00:59.000Z', answered: false },
        guardPlate: null,
      },
      // Auto-pause on without huginn: no finding is confirmed, so the watch never pauses it.
      { printerId: 'a1', name: 'A1', state: 'idle', camera: 'can_watch', watchedNow: false, autoPause: true, huginn: false, pausesOnFailure: false, bedMask: true, guard: true, guardTrip: null, guardPlate: '2026-11-03T07:30:00.000Z' },
      // Printing with no camera: nothing to watch, and the person turned the guard off.
      { printerId: 'sm2', name: 'Snapmaker', state: 'printing', camera: 'no_camera', watchedNow: false, autoPause: false, huginn: false, pausesOnFailure: false, bedMask: false, guard: false, guardTrip: null, guardPlate: null },
    ])
    expect(detector(r)).toBe(true)
    // Reads only; nothing the person sets was asked for.
    const asked = new Set(h0.sent.map((s) => s.method))
    expect(asked).toContain('settings.get')
    expect(asked).toContain('watch.huginnPrinters')
    expect(asked).toContain('watch.masks')
    expect(asked).toContain('watch.guardState')
    for (const m of APP_ONLY) expect(asked.has(m), m).toBe(false)
  })

  it('reads one printer by id, and refuses an unknown one with not_found', async () => {
    const h0 = hub()
    const h = await connect(link(h0))
    const one = await h.call('slicerx_print_watch_status', { printerId: 'a1' })
    expect(rows(one).map((p) => p.printerId)).toEqual(['a1'])
    expect(h0.sent.filter((s) => s.method === 'status').map((s) => s.params['printerId'])).toEqual(['a1'])
    const gone = await h.call('slicerx_print_watch_status', { printerId: 'gone' })
    expect(gone).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } })
  })

  it('leaves a column null when the hub does not answer that read, instead of failing', async () => {
    const h = await connect(
      link(
        hub({
          'watch.huginnPrinters': () => Promise.reject({ code: 'bad_request', message: 'unknown method watch.huginnPrinters' }),
          'watch.masks': () => Promise.reject({ code: 'bad_request', message: 'unknown method watch.masks' }),
          status: (_m, p) => (p['printerId'] === 'a1' ? Promise.reject({ code: 'offline', message: 'no answer' }) : STATUS[String(p['printerId'])]),
        }),
      ),
    )
    const r = rows(await h.call('slicerx_print_watch_status', {}))
    expect(r.find((p) => p.printerId === 'bay-4')).toMatchObject({ autoPause: true, huginn: null, pausesOnFailure: false, bedMask: null, watchedNow: true })
    expect(r.find((p) => p.printerId === 'a1')).toMatchObject({ state: null, camera: null, watchedNow: false, autoPause: true })
  })

  it('leaves the guard columns and detector null on a hub that refuses watch.guardState to an agent, as older hubs do', async () => {
    const h = await connect(link(hub({ 'watch.guardState': () => Promise.reject({ code: 'forbidden', message: 'watch.guardState is for the app' }) })))
    const r = await h.call('slicerx_print_watch_status', {})
    expect(r.isError, text(r)).toBeFalsy()
    for (const p of rows(r)) expect(p, p.printerId).toMatchObject({ guard: null, guardTrip: null, guardPlate: null })
    expect(rows(r).find((p) => p.printerId === 'bay-4')).toMatchObject({ autoPause: true, huginn: true, bedMask: false })
    expect(detector(r)).toBeNull()
  })

  it("reads one printer's guard trip, and no trip once the guard is clear and no detector is connected", async () => {
    const one = await (await connect(link(hub()))).call('slicerx_print_watch_status', { printerId: 'bay-4' })
    expect(rows(one)[0]?.guardTrip).toMatchObject({ kind: 'hand', state: 'paused' })
    const quiet = await (await connect(link(hub({ 'watch.guardState': () => ({ trips: {}, off: [], plates: {}, detector: false }) })))).call('slicerx_print_watch_status', { printerId: 'bay-4' })
    expect(rows(quiet)[0]).toMatchObject({ guard: true, guardTrip: null, guardPlate: null })
    expect(detector(quiet)).toBe(false)
  })

  it('treats a hub without the auto-pause list as auto-pause off', async () => {
    const h = await connect(link(hub({ 'settings.get': () => ({ experimentalConnectors: false }) })))
    const r = rows(await h.call('slicerx_print_watch_status', {}))
    expect(r.every((p) => !p.autoPause && !p.pausesOnFailure)).toBe(true)
  })

  it('refuses simulated printers with not_supported and no_watch', async () => {
    const demo = await connect({ printers: 'demo' })
    const r = await demo.call('slicerx_print_watch_status', {})
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported', details: { reason: 'no_watch' } } } })
    expect(text(r)).toMatch(/no print watch/)
  })
})

describe('no client changes the print watch', () => {
  it('no tool offers to turn auto-pause, huginn, the bed mask or the camera guard on or off', async () => {
    const { client } = await connect({ printers: 'demo' })
    for (const t of (await client.listTools()).tools) {
      expect(t.name, t.name).not.toMatch(/watch_(set|enable|disable)|auto_?pause|set_?guard|set_?mask|huginn/i)
      expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/"(autoPause|auto_pause|huginn|bedMask|mask)"\s*:/)
    }
  })

  it("no server code calls the hub's print watch setters or the guard's frame", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) {
      const body = readFileSync(join(src, f), 'utf8')
      expect(body, f).not.toMatch(/watch\.(autoPause|huginn|mask|guard|dismiss|evidence|resume|plateClear|plateCheck|plateIgnore|handCheck)\b|setAutoPause|setHuginn|setMask\(|setGuard\(/)
    }
  })
})
