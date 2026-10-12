// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Real printers through the real sx-link binary and the mock printers: approvals for printer
// calls go to sx-link's broker, which is what the bridge verifies. Skipped when sx-link is not built.
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectLink } from '@slicerx/link-client'
import { MOCK_HA_TOKEN, startMocks, type RunningMocks } from '@slicerx/mock-printers'
import { connect, data, text } from './helpers'

// Runs only when SX_LINK_BIN names a built sx-link, with a throwaway state directory and file
// secrets, so a test never touches the real hub state or the keychain.
const bin = process.env['SX_LINK_BIN'] ?? ''
const dir = bin && existsSync(bin) ? mkdtempSync(join(tmpdir(), 'sx-link-test-')) : ''

describe.skipIf(!bin || !existsSync(bin))('real printers through sx-link', () => {
  let proc: ChildProcessByStdio<null, Readable, Readable>
  let mocks: RunningMocks
  let url = ''
  let code = ''

  beforeAll(async () => {
    mocks = await startMocks({ only: ['moonraker', 'spoolman', 'home-assistant'], state: 'idle' })
    proc = spawn(bin, ['--port', '0', '--state-dir', dir, '--secrets', 'file', '--no-mdns', ...(process.env['SX_TEST_LAN'] === '1' ? [] : ['--loopback'])], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    await new Promise<void>((done, fail) => {
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString()
        const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
        const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
        if (u && c) {
          url = u[0]
          code = c[1] ?? ''
          done()
        }
      })
      proc.once('exit', () => fail(new Error('sx-link exited early')))
    })
    const setup = await connectLink({ url, code })
    await setup.addPrinter({ id: 'bay-4', name: 'Bay 4', plugin: 'moonraker', host: '127.0.0.1', port: mocks.ports.moonraker ?? 0 }, { model: 'Voron 2.4 350' })
    // The connected apps, added the way Settings, Connected apps adds them: the key into the bridge's secret store, then the address.
    await setup.configureService('spoolman', `http://127.0.0.1:${mocks.ports.spoolman ?? 0}`)
    await setup.setSecret('connected-apps/home-assistant', MOCK_HA_TOKEN)
    await setup.configureService('home-assistant', `http://127.0.0.1:${mocks.ports['home-assistant'] ?? 0}`, 'connected-apps/home-assistant')
    setup.close()
  }, 30_000)

  afterAll(async () => {
    proc?.kill()
    if (dir) rmSync(dir, { recursive: true, force: true })
    await mocks?.stop()
  })

  it('reads status, and leaves a heater change for a person to approve in SlicerX', async () => {
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    const st = await h.call('slicerx_printer_status', { printerId: 'bay-4' })
    expect(st.isError, text(st)).toBeFalsy()
    expect(text(st)).toContain('idle')

    const req = data<{ status: string; request_id: string }>(await h.call('slicerx_printer_set_temperature', { printerId: 'bay-4', heater: 'bed', celsius: 60 }))
    expect(req.status).toBe('needs_person')
    const tried = await h.call('slicerx_approve', { request_id: req.request_id, approve: true })
    expect(tried.isError).toBe(true)
    expect(text(tried)).toMatch(/in SlicerX or on the phone/)
  })

  it("reads a printer's own print history through the hub, newest first, without touching the printer", async () => {
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_printer_history')
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    // What the printer was asked to change, from the mock's control server.
    const changes = async () => ((await (await fetch(`http://127.0.0.1:${mocks.control}/state`)).json()) as { moonraker: { state: string; log: string[] } }).moonraker
    const before = await changes()
    const r = await h.call('slicerx_printer_history', { printerId: 'bay-4', limit: 5 })
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ output: { printerId: string; total: number; jobs: { name: string; result: string; started_at: string | null; ended_at: string | null; duration_s: number | null; filament_mm?: number }[] } }>(r).output
    expect(out.printerId).toBe('bay-4')
    expect(out.jobs[0]).toEqual({
      name: 'earlier.gcode',
      result: 'completed',
      started_at: new Date(1_700_000_000_000).toISOString(),
      ended_at: new Date((1_700_000_000 + 5400) * 1000).toISOString(),
      duration_s: 5400,
      filament_mm: 4200,
    })
    expect(out.jobs.length).toBeLessThanOrEqual(5)
    expect(await changes()).toEqual(before)
    await expect(h.call('slicerx_printer_history', { printerId: 'bay-4', limit: 0 }).then((x) => x.isError)).resolves.toBe(true)
  })

  it('leaves adding a printer to the SlicerX app, since the hub refuses it from agents', async () => {
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    const hits = data<{ output: { id: string }[] }>(await h.call('slicerx_printer_profile_search', { query: 'voron 2.4' }))
    const profileId = hits.output[0]?.id ?? 'voron-2-4-350'
    const args = { profileId, nozzleMm: 0.4, name: 'Bay 5', connection: { family: 'moonraker', address: `127.0.0.1:${mocks.ports.moonraker ?? 0}` } }
    const r = await h.call('slicerx_printer_add', args)
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/done in the SlicerX app/)
    expect(text(await h.call('slicerx_printer_list'))).not.toContain('Bay 5')
  })

  it('Connect your AI agent: a credential from clients.create pairs the server as an agent, and revoking it shuts it out', async () => {
    const app = await connectLink({ url, code })
    const { clientId, clientKey, role } = await app.clients.create('Cursor (this computer)', 'agent')
    expect(role).toBe('agent')
    // A saved key goes only to the pinned hub, as the installed config does with SLICERX_MCP_LINK_HUB_KEY.
    const pinned = { linkHubKey: app.hubKey ?? '' }
    const h = await connect({ printers: 'link', linkUrl: url, linkClientKey: clientKey, ...pinned })
    const st = await h.call('slicerx_printer_status', { printerId: 'bay-4' })
    expect(st.isError, text(st)).toBeFalsy()
    // Still an agent: a start-class request waits for a person.
    const req = data<{ status: string }>(await h.call('slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' }))
    expect(['needs_person', 'approval_required']).toContain(req.status)
    const listed = await app.clients.list()
    expect(listed.find((c) => c.id === clientId)?.role).toBe('agent')
    await app.clients.revoke(clientId)
    await expect(connect({ printers: 'link', linkUrl: url, linkClientKey: clientKey, ...pinned }).then((x) => x.call('slicerx_printer_status', { printerId: 'bay-4' })).then((r) => (r.isError ? Promise.reject(new Error(text(r))) : r))).rejects.toThrow()
    app.close()
  })

  it('Partner app: a partner key reads printers, answers its own pause card, and is refused G-code', async () => {
    const app = await connectLink({ url, code })
    const { clientId, clientKey, partner } = await app.clients.create('LayerMate', 'agent', { partner: true })
    expect(partner).toBe(true)
    expect(clientKey).toMatch(/^sxp_[0-9a-f]{64}$/)
    const h = await connect({ printers: 'link', linkUrl: url, linkClientKey: clientKey, linkHubKey: app.hubKey ?? '' })
    const st = await h.call('slicerx_printer_status', { printerId: 'bay-4' })
    expect(st.isError, text(st)).toBeFalsy()
    const pause = data<{ status: string; request_id: string }>(await h.call('slicerx_printer_pause', { printerId: 'bay-4' }))
    expect(pause.status).toBe('approval_required')
    const card = (await app.approvals.pending()).find((r) => r.id === pause.request_id)
    expect(card?.lines[0]).toBe('Asked by LayerMate, a partner app')
    // Bay 4 is idle, so withdraw the card rather than pause.
    await h.call('slicerx_approve', { request_id: pause.request_id, approve: false })
    const g = await h.call('slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' })
    expect(g.isError).toBe(true)
    expect(text(g)).toMatch(/partner app may ask only to print, pause or cancel/)
    await app.clients.revoke(clientId)
    app.close()
  })

  it('Home Assistant: an agent asks to switch a plug, and the hub switches it once a person approves in SlicerX', async () => {
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    const state = async (id: string) => data<{ output: { entityId: string; state: string }[] }>(await h.call('slicerx_home_assistant_list_entities', { domain: 'switch' })).output.find((e) => e.entityId === id)?.state
    expect(await state('switch.bay_2_power')).toBe('on')
    const req = data<{ status: string; request_id: string }>(await h.call('slicerx_home_assistant_call_service', { domain: 'switch', service: 'turn_off', entityId: 'switch.bay_2_power' }))
    expect(req.status).toBe('needs_person')
    // The agent cannot answer it, and nothing has changed yet.
    expect((await h.call('slicerx_approve', { request_id: req.request_id, approve: true })).isError).toBe(true)
    expect(await state('switch.bay_2_power')).toBe('on')
    // The person approves in the app; the hub runs the call with the token, which the agent never sees.
    const app = await connectLink({ url, code })
    const card = (await app.approvals.pending()).find((r) => r.id === req.request_id) as { work?: { kind: string; pluginId?: string; input?: unknown } } | undefined
    expect(card?.work).toMatchObject({ kind: 'plugin', pluginId: 'home-assistant', input: { entityId: 'switch.bay_2_power' } })
    await app.approvals.grant(req.request_id)
    await expect.poll(() => state('switch.bay_2_power'), { timeout: 5000 }).toBe('off')
    // The approval was used: granting the same card again is refused, and nothing runs twice.
    await expect(app.approvals.grant(req.request_id)).rejects.toThrow()
    app.close()
  })

  it('a declined request leaves the printer alone', async () => {
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    const req = data<{ request_id: string }>(await h.call('slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' }))
    const r = await h.call('slicerx_approve', { request_id: req.request_id, approve: false })
    expect(data<{ status: string }>(r).status).toBe('denied')
  })
})

// A client's printer scan through the hub finds a Prusa printer: the hub's PrusaLink scan reads the neighbour table,
// which a test build (sx-link with `test-hooks`) takes from SX_TEST_NEIGHBORS, here the PrusaLink fake's address.
describe.skipIf(!bin || !existsSync(bin))('a printer scan through sx-link', () => {
  let proc: ChildProcessByStdio<null, Readable, Readable>
  let mocks: RunningMocks
  let url = ''
  let code = ''
  const scanDir = bin && existsSync(bin) ? mkdtempSync(join(tmpdir(), 'sx-link-scan-')) : ''

  beforeAll(async () => {
    mocks = await startMocks({ only: ['prusalink'], state: 'idle' })
    const env = { ...process.env, SX_TEST_NEIGHBORS: `127.0.0.1:${mocks.ports.prusalink ?? 0}` }
    proc = spawn(bin, ['--port', '0', '--state-dir', scanDir, '--secrets', 'file', '--no-mdns', '--loopback'], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = ''
    await new Promise<void>((done, fail) => {
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString()
        const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
        const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
        if (u && c) {
          url = u[0]
          code = c[1] ?? ''
          done()
        }
      })
      proc.once('exit', () => fail(new Error('sx-link exited early')))
    })
  }, 30_000)

  afterAll(async () => {
    proc?.kill()
    if (scanDir) rmSync(scanDir, { recursive: true, force: true })
    await mocks?.stop()
  })

  it('lists the Prusa printer the neighbour table points at, with its address', async () => {
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    const found = data<{ output: { family: string; address: string | null; name: string }[] }>(await h.call('slicerx_printer_discover', { timeoutMs: 3000 }))
    const prusa = found.output.find((f) => f.family === 'prusalink')
    expect(prusa, JSON.stringify(found.output)).toBeDefined()
    expect(prusa?.address).toContain('127.0.0.1')
  })
})
