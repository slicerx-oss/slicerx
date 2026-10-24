// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The send card ledger in the guard (docs/safety.md): an entry the send card wrote for this request, printer and file
// skips the guard's second card once, after the preflight runs again; a preflight that now fails refuses without a
// card; without an entry, for another file or a second time, the guard shows its own bed-clear card as before. Only
// the send card's Print handler writes the ledger.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalToken, PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { guardedPrinters, sendPreflight } from '../src/plate/guard'
import { createSendLedger } from '../src/plate/send-ledger'
import { get, set } from '../src/state/store'

const info: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1 }
const idle: PrinterStatus = { printerId: 'bay-2', state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: '' }
const SHA = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const later = () => new Date(Date.now() + 5 * 60_000).toISOString()
const token = (requestId: string): ApprovalToken => ({ requestId, token: 'tok', expiresAt: later() })
const file = (sha256 = SHA) => ({ name: 'clip.gcode.3mf', kind: 'gcode.3mf' as const, data: new ArrayBuffer(0), sha256 })

// The guard loads the preflight on demand. A cold worker on a busy machine takes tens of seconds to transform it, so load it
// before the wait for the card starts.
beforeAll(async () => void (await Promise.all([import('../src/plate/preflight'), import('../src/plate/transform'), import('../src/state/slice-plate')])))

function fake(status: () => PrinterStatus = () => idle) {
  const calls: string[] = []
  const printers = {
    list: async () => [info],
    status: async () => status(),
    upload: async (id: string, f: { name: string }) => {
      calls.push(`upload ${f.name}`)
      return { printerId: id, path: `/${f.name}`, name: f.name }
    },
    start: async (f: { name: string }) => void calls.push(`start ${f.name}`),
    resume: async (id: string) => void calls.push(`resume ${id}`),
  } as unknown as PrinterHost
  const ledger = createSendLedger()
  return { calls, printers, ledger, guarded: guardedPrinters({ printers }, { ledger })! }
}

/** Waits for the guard's own card, then answers it. Generous, as in guard.test.ts: the preflight module loads lazily. */
async function answer(approve: boolean): Promise<void> {
  await vi.waitFor(() => expect(get().approval).not.toBeNull(), { timeout: 45_000, interval: 5 })
  const a = get().approval!
  expect(a.confirm).toBe('The bed is clear and the right build plate is on it')
  await (approve ? a.approve() : a.deny())
}

beforeEach(() => set({ approval: null, plate: [], slice: { status: 'idle' } }))

describe('the send ledger in the guard', () => {
  it('without a ledger entry the guard shows its own card', async () => {
    const { calls, guarded } = fake()
    const up = guarded.upload('bay-2', file(), token('apr_1'))
    await answer(true)
    await up
    expect(calls).toEqual(['upload clip.gcode.3mf'])
  })

  it('a ledger entry skips the second card once', async () => {
    const { calls, guarded, ledger } = fake()
    ledger.mark('apr_1', 'bay-2', SHA, later())
    const remote = await guarded.upload('bay-2', file(), token('apr_1'))
    expect(get().approval).toBeNull()
    // the start right after it skips its card too
    await guarded.start(remote, {}, token('apr_1'))
    expect(get().approval).toBeNull()
    expect(calls).toEqual(['upload clip.gcode.3mf', 'start clip.gcode.3mf'])
  })

  it('the same entry cannot be used twice', async () => {
    const { calls, guarded, ledger } = fake()
    ledger.mark('apr_1', 'bay-2', SHA, later())
    await guarded.upload('bay-2', file(), token('apr_1'))
    expect(calls).toEqual(['upload clip.gcode.3mf'])
    // the second upload with the same request gets the guard's own card, and a no sends nothing
    const again = guarded.upload('bay-2', file(), token('apr_1'))
    await answer(false)
    await expect(again).rejects.toThrow(/Nothing was sent/)
    expect(calls).toEqual(['upload clip.gcode.3mf'])
  })

  it('an entry for another file hash does not count', async () => {
    const { calls, guarded, ledger } = fake()
    ledger.mark('apr_1', 'bay-2', SHA, later())
    const up = guarded.upload('bay-2', file(OTHER), token('apr_1'))
    await answer(false)
    await expect(up).rejects.toThrow(/Nothing was sent/)
    // nor for another printer or request
    ledger.mark('apr_2', 'bay-9', SHA, later())
    const other = guarded.upload('bay-2', file(), token('apr_2'))
    await answer(false)
    await expect(other).rejects.toThrow(/Nothing was sent/)
    expect(calls).toEqual([])
  })

  it('a preflight that now fails refuses without a card', async () => {
    const { calls, guarded, ledger } = fake(() => ({ ...idle, state: 'printing', timeLeftS: 3600 }))
    ledger.mark('apr_1', 'bay-2', SHA, later())
    await expect(guarded.upload('bay-2', file(), token('apr_1'))).rejects.toThrow('Preflight failed: Bay 2 is printing, about 1h 0m left. Pick another printer or wait until it finishes. Nothing was sent to the printer.')
    expect(get().approval).toBeNull()
    expect(calls).toEqual([])
  })

  it('a failed upload lets no start skip its card', async () => {
    const { calls, printers, guarded, ledger } = fake()
    ;(printers as unknown as { upload: () => Promise<never> }).upload = async () => Promise.reject(new Error('printer storage full'))
    ledger.mark('apr_1', 'bay-2', SHA, later())
    await expect(guarded.upload('bay-2', file(), token('apr_1'))).rejects.toThrow('printer storage full')
    // the start of a file by that name asks on the guard's own card, and a no starts nothing
    const start = guarded.start({ printerId: 'bay-2', path: '/clip.gcode.3mf', name: 'clip.gcode.3mf' }, {}, token('apr_1'))
    await answer(false)
    await expect(start).rejects.toThrow(/Nothing was sent/)
    expect(calls).toEqual([])
  })

  it('every way of reading the guarded host gives the guarded calls, and nothing can be written onto it', () => {
    const { printers, guarded } = fake()
    const raw = printers as unknown as Record<string, unknown>
    expect(Object.keys(guarded)).toEqual(expect.arrayContaining(['upload', 'start', 'resume', 'list', 'status']))
    const spread = { ...guarded } as unknown as Record<string, unknown>
    for (const k of ['upload', 'start', 'resume'] as const) {
      expect(spread[k]).toBe(guarded[k])
      expect(spread[k]).not.toBe(raw[k])
      expect(Object.getOwnPropertyDescriptor(guarded, k)?.value).toBe(guarded[k])
    }
    expect(typeof spread['list']).toBe('function')
    expect(Object.getOwnPropertyDescriptor(guarded, 'nothing_here')).toBeUndefined()
    expect(() => {
      ;(guarded as unknown as Record<string, unknown>)['upload'] = raw['upload']
    }).toThrow(TypeError)
    expect(() => Object.defineProperty(guarded, 'start', { value: raw['start'] })).toThrow(TypeError)
    expect(guarded.upload).not.toBe(raw['upload'])
  })

  it('an entry expires', () => {
    let t = 1_000
    const ledger = createSendLedger(() => t)
    ledger.mark('apr_1', 'bay-2', SHA, new Date(2_000).toISOString())
    t = 2_001
    expect(ledger.take('apr_1', 'bay-2', SHA)).toBe(false)
    ledger.mark('apr_2', 'bay-2', SHA, new Date(5_000).toISOString())
    expect(ledger.take('apr_2', 'bay-2', SHA)).toBe(true)
    expect(ledger.take('apr_2', 'bay-2', SHA)).toBe(false)
  })

  it('expired entries are pruned on mark', () => {
    let t = 1_000
    const ledger = createSendLedger(() => t)
    ledger.mark('apr_1', 'bay-2', SHA, new Date(2_000).toISOString())
    ledger.mark('apr_2', 'bay-2', SHA, new Date(9_000).toISOString())
    expect(ledger.size()).toBe(2)
    t = 3_000
    ledger.mark('apr_3', 'bay-2', SHA, new Date(9_000).toISOString())
    expect(ledger.size()).toBe(2)
    expect(ledger.take('apr_2', 'bay-2', SHA)).toBe(true)
  })

  it('sendPreflight adds the busy state and Developer Mode', async () => {
    const { printers } = fake(() => ({ ...idle, live: { needsDeveloperMode: true } }))
    const dev = await sendPreflight(printers, 'bay-2', { name: 'clip.gcode.3mf', sha256: SHA })
    expect(dev.busy).toBeNull()
    expect(dev.developerMode?.map((r) => r.id)).toEqual(['developer_mode', 'bambu_connect'])
    expect(dev.errors).toContain('Bay 2 turns away prints from other apps while Developer Mode is off.')
    const ok = await sendPreflight(fake().printers, 'bay-2', { name: 'clip.gcode.3mf', sha256: SHA })
    expect(ok).toMatchObject({ errors: [], busy: null, developerMode: null, printerName: 'Bay 2' })
  })

  it('only the send card writes the ledger', () => {
    // vitest runs in packages/app
    const root = join(process.cwd(), 'src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(n)) files.push(p)
      }
    }
    walk(root)
    const writers = files.filter((f) => /\.mark\(/.test(readFileSync(f, 'utf8')) && /send-ledger/.test(readFileSync(f, 'utf8')))
    expect(writers.map((f) => f.slice(root.length + 1))).toEqual(['workspaces/mimir/send-card.tsx'])
    const users = files.filter((f) => /from '[./]*\/?(plate\/)?send-ledger'/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1))
    expect(users.sort()).toEqual(['plate/guard.ts', 'workspaces/mimir/send-card.tsx', 'workspaces/mimir/session.ts'])
  })
})
