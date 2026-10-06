// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printing on a Bambu Lab printer with Developer Mode off: the printer is monitor-only, and Print goes through Bambu
// Connect (Bambu Lab's URL scheme), or saves the file on Linux and in the browser. With Developer Mode on, prints go
// straight from the app as before.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BambuConnectHost, Host, JobFile } from '@slicerx/contracts'
import { unzipEntries } from '../src/export/import3mf'
import { BAMBU_CONNECT_DOWNLOAD, handOffCopy, handToBambuConnect, onLinux, printRoute, type HandOff } from '../src/send/bambu-connect'
import { PrintSheet, type PrintSheetAsk } from '../src/send/print-sheet'
import { supportedOptions } from '../src/send/options'
import { sendToPrinter } from '../src/state/actions'
import { get, set } from '../src/state/store'

beforeAll(() => {
  // jsdom has no modal dialogs.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

const roots: (() => void)[] = []
afterEach(() => {
  for (const u of roots.splice(0)) u()
  set({ printSheet: null, toast: null })
  vi.restoreAllMocks()
})

const bambu = { id: 'a1', name: 'A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1 } as const
const watching = { state: 'idle', slots: [], live: { monitorOnly: true } }
const save = (name: string | null) => async (suggested: string) => (name === null ? null : { id: '1', name: name || suggested, size: 1 })

describe('which way a print goes', () => {
  it('goes through Bambu Connect only when a Bambu Lab printer reports Developer Mode off', () => {
    expect(printRoute(bambu, watching)).toBe('bambu-connect')
    expect(printRoute(bambu, { live: {} })).toBe('direct')
    expect(printRoute(bambu, { live: { monitorOnly: false } } as never)).toBe('direct')
    expect(printRoute(bambu, null)).toBe('direct')
    expect(printRoute({ plugin: 'moonraker' }, watching)).toBe('direct')
  })

  it('knows Linux from the browser, and not Android', () => {
    expect(onLinux({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' })).toBe(true)
    expect(onLinux({ userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' })).toBe(false)
    expect(onLinux({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(false)
    expect(onLinux({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false)
  })
})

describe('the hand-off', () => {
  const file = { name: 'cube.gcode.3mf', data: new Uint8Array([1, 2, 3]).buffer }
  const desktop = (r: Awaited<ReturnType<BambuConnectHost['open']>>) => {
    const open = vi.fn(async () => r)
    return { open, host: { bambuConnect: { open }, files: { save: vi.fn(save('cube.gcode.3mf')) } } }
  }

  it('opens the file in Bambu Connect on the desktop', async () => {
    const d = desktop('opened')
    expect(await handToBambuConnect(d.host, file, 'Cube', false)).toEqual({ outcome: 'opened' })
    expect(d.open).toHaveBeenCalledWith('cube.gcode.3mf', file.data, 'Cube')
    expect(d.host.files.save).not.toHaveBeenCalled()
  })

  it('says when Bambu Connect is not installed, and saves nothing', async () => {
    const d = desktop('missing')
    expect(await handToBambuConnect(d.host, file, 'Cube', false)).toEqual({ outcome: 'missing' })
    expect(d.host.files.save).not.toHaveBeenCalled()
  })

  it('saves the file on Linux, where Bambu Connect does not exist', async () => {
    const shell = desktop('unsupported')
    expect(await handToBambuConnect(shell.host, file, 'Cube', false)).toEqual({ outcome: 'saved', fileName: 'cube.gcode.3mf', why: 'linux' })
    const d = desktop('opened')
    expect(await handToBambuConnect(d.host, file, 'Cube', true)).toEqual({ outcome: 'saved', fileName: 'cube.gcode.3mf', why: 'linux' })
    expect(d.open).not.toHaveBeenCalled()
  })

  it('saves the file in the browser, which has no path to hand over', async () => {
    const files = { save: vi.fn(save('')) }
    expect(await handToBambuConnect({ files }, file, 'Cube', false)).toEqual({ outcome: 'saved', fileName: 'cube.gcode.3mf', why: 'web' })
    expect(files.save).toHaveBeenCalledWith('cube.gcode.3mf', file.data, { accept: ['.3mf'] })
    expect(await handToBambuConnect({ files: { save: save(null) } }, file, 'Cube', false)).toEqual({ outcome: 'canceled' })
  })

  it('says each outcome in one plain line, with Bambu Lab\'s download page where it is needed', () => {
    const say = (h: HandOff) => handOffCopy(h, 'SlicerX')
    expect(say({ outcome: 'opened' })).toEqual({ text: 'Opening in Bambu Connect: press Print there', tone: 'ok' })
    expect(say({ outcome: 'missing' })).toEqual({ text: 'Bambu Connect isn\'t installed. Install it from Bambu Lab, then print again.', tone: 'warn', download: BAMBU_CONNECT_DOWNLOAD })
    expect(say({ outcome: 'saved', fileName: 'cube.gcode.3mf', why: 'linux' }).text).toBe(
      'Saved cube.gcode.3mf. Bambu Connect isn\'t available for Linux yet: copy the file to the printer\'s SD card and start it there, or turn on Developer Mode to print directly from SlicerX.',
    )
    expect(say({ outcome: 'saved', fileName: 'cube.gcode.3mf', why: 'linux' }).download).toBeUndefined()
    expect(say({ outcome: 'saved', fileName: 'cube.gcode.3mf', why: 'web' })).toEqual({ text: 'Saved cube.gcode.3mf. Open it in Bambu Connect and press Print there.', tone: 'info', download: BAMBU_CONNECT_DOWNLOAD })
    expect(BAMBU_CONNECT_DOWNLOAD).toBe('https://wiki.bambulab.com/en/software/bambu-connect')
    const all = (['opened', 'missing', 'canceled'] as const).map((o) => say({ outcome: o } as HandOff).text).join(' ') + say({ outcome: 'saved', fileName: 'x', why: 'linux' }).text + say({ outcome: 'saved', fileName: 'x', why: 'web' }).text
    expect(all).not.toMatch(new RegExp('[\u2013\u2014]'))
  })
})

/** A plate the engine sliced for a Bambu Lab printer. */
const GCODE = ['; HEADER_BLOCK_START', '; model label id: 1', '; HEADER_BLOCK_END', '; start printing object, unique label id: 1', 'G1 X60 Y60', 'G1 X80 Y80 E1', '; stop printing object, unique label id: 1', '; filament used [g] = 7.29', '; estimated printing time (normal mode) = 24m 47s', ''].join('\n')

function hub(status: Record<string, unknown>, bambuConnect?: BambuConnectHost) {
  const uploads: JobFile[] = []
  const printers = {
    status: async () => status,
    upload: async (printerId: string, file: JobFile) => {
      uploads.push(file)
      return { printerId, path: file.name, name: file.name, sha256: file.sha256 }
    },
    start: async () => undefined,
  }
  const approvals = { register: async () => undefined, grant: async (id: string) => ({ requestId: id }), deny: async () => undefined }
  const blob = new Blob([GCODE], { type: 'text/x-gcode' })
  const saved: string[] = []
  const files = { save: async (name: string) => (saved.push(name), { id: '1', name, size: 1 }) }
  const host = { kind: bambuConnect ? 'desktop' : 'web', printers, approvals, files, ...(bambuConnect ? { bambuConnect } : {}), slicer: { exportGcode: async () => ({ blob, bytes: blob.size, sha256: 'x' }) } } as unknown as Host
  return { host, uploads, saved }
}

async function printThroughSheet(host: Host) {
  set({ slice: { status: 'done', stale: false, result: { id: 'r1', layerCount: 100, warnings: [], stats: { timeS: 1487, filamentG: [7.29], filamentMm: [2403], cost: 0, toolChanges: 0 } } } as never, plate: [], approval: null, printSheet: null, toast: null })
  const done = sendToPrinter(host, bambu as never)
  await vi.waitFor(() => expect(get().printSheet?.check).toBeTruthy(), { timeout: 5000 })
  return { done, ask: get().printSheet! }
}

describe('Print on a Bambu Lab printer', () => {
  it('with Developer Mode off, opens the .gcode.3mf in Bambu Connect and sends nothing to the printer', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    const opened: { name: string; data: ArrayBuffer; title: string }[] = []
    const h = hub(watching, { open: async (name, data, title) => (opened.push({ name, data, title }), 'opened') })
    const { done, ask } = await printThroughSheet(h.host)
    expect(ask.connectOnly).toBe(true)
    expect(ask.bambuConnect).toBe('open')
    ask.resolve({ options: {}, start: true, name: 'cube.gcode.3mf', bambuConnect: true })
    await done
    expect(h.uploads).toHaveLength(0)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.name).toBe('cube.gcode.3mf')
    expect(opened[0]!.title).toBe('Plate 1')
    const inside = await unzipEntries(new Uint8Array(opened[0]!.data))
    expect(new TextDecoder().decode(inside.get('Metadata/plate_1.gcode'))).toContain('G1 X80 Y80 E1')
    expect(get().toast).toMatchObject({ text: 'Opening in Bambu Connect: press Print there', tone: 'ok' })
  })

  it('with Developer Mode on, prints directly as before', async () => {
    const h = hub({ state: 'idle', slots: [] }, { open: async () => 'opened' })
    const { done, ask } = await printThroughSheet(h.host)
    expect(ask.connectOnly).toBeUndefined()
    ask.resolve({ options: {}, start: true, name: 'cube.gcode.3mf' })
    await done
    expect(h.uploads.map((u) => u.name)).toEqual(['cube.gcode.3mf'])
  })

  it('says Bambu Connect is missing with a link to Bambu Lab\'s download page', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    const h = hub(watching, { open: async () => 'missing' })
    const { done, ask } = await printThroughSheet(h.host)
    ask.resolve({ options: {}, start: true, name: 'cube.gcode.3mf', bambuConnect: true })
    await done
    const t = get().toast!
    expect(t.text).toBe('Bambu Connect isn\'t installed. Install it from Bambu Lab, then print again.')
    expect(t.action?.label).toBe('Get Bambu Connect')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    t.action!.run()
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(BAMBU_CONNECT_DOWNLOAD, '_blank', 'noopener'))
    expect(h.uploads).toHaveLength(0)
  })

  it('on Linux, saves the file and says why', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    const open = vi.fn(async () => 'opened' as const)
    const h = hub(watching, { open })
    const { done, ask } = await printThroughSheet(h.host)
    expect(ask.bambuConnect).toBe('save')
    ask.resolve({ options: {}, start: true, name: 'cube.gcode.3mf', bambuConnect: true })
    await done
    expect(open).not.toHaveBeenCalled()
    expect(h.saved).toEqual(['cube.gcode.3mf'])
    expect(get().toast?.text).toContain('Bambu Connect isn\'t available for Linux yet')
    expect(h.uploads).toHaveLength(0)
  })
})

function ask(over: Partial<PrintSheetAsk> = {}): PrintSheetAsk {
  return {
    printer: { id: 'a1', name: 'Bay 1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', filamentSystem: 'ams' } as PrintSheetAsk['printer'],
    status: { state: 'idle', slots: [], cameraAvailable: true } as unknown as PrintSheetAsk['status'],
    plateName: 'Plate 1',
    specs: supportedOptions({ vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan' }),
    initial: {},
    name: 'cube.gcode.3mf',
    ending: '.gcode.3mf',
    filaments: [{ index: 1, color: '#ff0000', type: 'PLA' }],
    slots: [{ id: 'A1', material: 'PLA', color: '#ff0000' }],
    auto: { 1: 'A1' },
    stats: { timeS: 3600, grams: 42.5, layers: 304 },
    check: { errors: [], warnings: [], sha256: 'abcdef0123456789' },
    bed: 'unknown',
    resolve: () => {},
    ...over,
  }
}

function open(a: PrintSheetAsk): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  set({ printSheet: a })
  flushSync(() => root.render(createElement(PrintSheet)))
  roots.push(() => {
    root.unmount()
    el.remove()
  })
  return el
}

const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean)

describe('the Print sheet with Developer Mode off', () => {
  it('offers Open in Bambu Connect alone, with no options, slot picks or start menu', () => {
    const resolve = vi.fn()
    const el = open(ask({ bambuConnect: 'open', connectOnly: true, resolve }))
    const b = buttons(el)
    expect(b).toContain('Open in Bambu Connect')
    expect(b.some((t) => /start print|Upload only|Queue/.test(t!))).toBe(false)
    expect(el.querySelector('.ps-opts')).toBeNull()
    expect(el.querySelector('.ps-note')?.textContent).toBe('Developer Mode is off on Bay 1, so the print goes through Bambu Connect, Bambu Lab\'s app for printing from other software. Press Print there.')
    const go = [...el.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Open in Bambu Connect')!
    flushSync(() => go.click())
    expect(resolve).toHaveBeenCalledWith({ options: {}, start: true, name: 'cube.gcode.3mf', bambuConnect: true })
  })

  it('says Save file where Bambu Connect cannot be opened', () => {
    const el = open(ask({ bambuConnect: 'save', connectOnly: true }))
    expect(buttons(el)).toContain('Save file')
    expect(el.querySelector('.ps-note')?.textContent).toContain('the file is saved for you to print')
  })

  it('keeps Open in Bambu Connect off while the file has a problem', () => {
    const el = open(ask({ bambuConnect: 'open', connectOnly: true, check: { errors: ['The plate is bigger than the bed'], warnings: [], sha256: 'x' } }))
    const go = [...el.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Open in Bambu Connect')!
    // A disabled button with a tip stays hoverable, so it is marked aria-disabled.
    expect(go.getAttribute('aria-disabled')).toBe('true')
  })

  it('offers Bambu Connect beside plain G-code after the printer refused a print', () => {
    const resolve = vi.fn()
    const el = open(ask({ bambuConnect: 'open', refusal: { reason: 'not authorized', plainSha256: 'abc', last: { options: {}, start: true, name: 'cube.gcode.3mf' } }, resolve }))
    const b = buttons(el)
    expect(b).toContain('Send as plain G-code')
    expect(b).toContain('Open in Bambu Connect')
    const go = [...el.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Open in Bambu Connect')!
    flushSync(() => go.click())
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ bambuConnect: true, name: 'cube.gcode.3mf' }))
  })

  it('keeps the direct sheet for a printer with Developer Mode on', () => {
    const el = open(ask({ bambuConnect: 'open' }))
    expect(buttons(el)).not.toContain('Open in Bambu Connect')
    expect(el.querySelector('.ps-opts')).not.toBeNull()
  })
})
