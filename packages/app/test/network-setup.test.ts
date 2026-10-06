// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Network first printer setup: a printer the scan found fills the form from what it announced and
// what it reported once connected, the catalog fills the rest, Test connection says why it is off,
// and a Bambu Lab printer is told where its access code is before anyone types one, with Developer Mode optional.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PrinterHardware } from '@slicerx/contracts'
import { connectionMethod } from '@slicerx/printer-catalog'
import { createElement, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { bambuFamily, BAMBU_GUIDES, DEVELOPER_EFFECT, LAN_ONLY_EFFECT } from '../src/first-run/bambu-lan'
import { BambuLanCard } from '../src/first-run/bambu-lan-card'
import { FAILURE_HELP } from '../src/first-run/help-topics'
import { AccessCodeScreen } from '../src/first-run/access-code-screen'
import { IMAGE_IDS, printerImage } from '../src/first-run/printer-images'
import { PrinterPicture } from '../src/first-run/printer-step'
import { PRINTER_MODELS } from '@slicerx/printer-catalog'
import { readdirSync, statSync } from 'node:fs'
import { ConfirmCard } from '../src/first-run/confirm-card'
import { Footer } from '../src/first-run/frame'
import { bedOf, checkConnection, EMPTY_FORM, extruderNozzles, profileIdOf, testBlockers, withHardware, type PrinterForm } from '../src/first-run/printer-form'
import { adoptFound, blockerHint, connectedText, foundText, TestCard, WhyNotReady, type PrinterController } from '../src/first-run/printer-step'
import { failureCopy, failureKind } from '../src/first-run/test-failure'
import { get, set } from '../src/state/store'
import { fromLinkResult, type FoundPrinter } from '../src/first-run/setup-registry'

/** What sx-link's printers.test returns for packages/connect/fixtures/bambu-h2d-pushall.json (written by the Rust contract test). */
const H2D: PrinterHardware = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/fixtures/printers-hardware.json'), 'utf8'))

/** An H2D as the scan lists it from its SSDP answer. */
const FOUND: FoundPrinter = { id: '0948AA000000001', name: 'Workshop H2D', family: 'bambu-lan', address: '192.168.1.52', model: 'H2D', serial: '0948AA000000001', firmware: '01.03.00.00', lanOnly: true }

const steps = (['reach', 'sign_in', 'read_state', 'read_temperatures'] as const).map((id) => ({ id, ok: true }))

function render(node: ReactElement): { el: HTMLDivElement; text: () => string; done: () => void } {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  flushSync(() => root.render(node))
  return { el, text: () => el.textContent ?? '', done: () => (root.unmount(), el.remove()) }
}

describe('a printer found on the network', () => {
  it('fills the model, address and serial number from what it announced, leaving only the access code', () => {
    const f = adoptFound(EMPTY_FORM, FOUND)
    expect(f.modelId).toBe('bambu-h2d')
    expect(f.connection).toBe('bambu-lan')
    expect(f.fields.host).toBe('192.168.1.52')
    expect(f.fields.serial).toBe('0948AA000000001')
    expect(testBlockers(f, connectionMethod('bambu-lan')).map((b) => b.field)).toEqual(['accessCode'])
  })

  it('fills both nozzles, their material and the AMS units from a recorded H2D report', () => {
    const outcome = fromLinkResult({ ok: true, state: 'idle', steps, nozzleC: 25, bedC: 24, hardware: H2D })
    expect(outcome.reportedModel).toBe('H2D')
    expect(outcome.firmware).toBe('01.03.00.00')
    expect(outcome.filamentSystem).toBe('ams')
    expect(outcome.slotCount).toBe(5)
    const f = withHardware(adoptFound(EMPTY_FORM, FOUND), outcome.hardware!)
    expect(f.nozzles).toEqual([
      { size: 0.6, other: '', type: 'hardened-steel', highFlow: true },
      { size: 0.4, other: '', type: 'hardened-steel' },
    ])
    expect(f.filament).toEqual({ kind: 'ams', units: 2, slots: 5 })
    expect(f.nozzleUnsure).toBe(false)
  })

  it('a failed test carries no hardware', () => {
    const outcome = fromLinkResult({ ok: false, cause: 'auth', steps: steps.map((s) => ({ ...s, ok: s.id === 'reach' })), hardware: H2D })
    expect(outcome.hardware).toBeUndefined()
    expect(outcome.nozzleMm).toBeUndefined()
  })
})

describe('the catalog fills what the printer does not report', () => {
  it('keeps the bed, toolhead and nozzle count of the model', () => {
    const f = withHardware(adoptFound(EMPTY_FORM, FOUND), { model: 'H2D' })
    expect(bedOf(f)).toEqual({ widthMm: 350, depthMm: 320, heightMm: 325 })
    expect(f.toolhead).toBe('direct')
    expect(f.nozzles).toHaveLength(2)
    expect(f.filament.kind).toBe('ams')
    expect(profileIdOf(f)).toBe('bambu-h2d')
  })

  it('shows one confirm card that says where each value came from', () => {
    const form = withHardware(adoptFound(EMPTY_FORM, FOUND), H2D)
    const r = render(createElement(ConfirmCard, { form, setForm: () => undefined, hardware: H2D, reportedNozzle: true, firmware: '01.03.00.00' }))
    const t = r.text()
    for (const part of [
      'Bambu Lab H2D',
      '350 x 320 x 325 mm',
      'CoreXY',
      'Firmware01.03.00.00',
      'Left nozzle: 0.6 mm, hardened steel, high flow',
      'Right nozzle: 0.4 mm, hardened steel',
      'Direct drive',
      'AMS 2 Pro, right nozzle',
      'AMS HT, left nozzle',
      'PLA Basic',
      'PAHT-CF',
      'External spool, left nozzle',
      'TPU for AMS',
      'Empty',
    ])
      expect(t, part).toContain(part)
    // The empty right external spool is left out.
    expect(t).not.toContain('External spool, right nozzle')
    expect(r.el.querySelectorAll('.fr-src').length).toBe(2)
    r.done()
  })
})

describe('why Test connection is off', () => {
  const bambu = connectionMethod('bambu-lan')
  const base: PrinterForm = { ...EMPTY_FORM, brand: 'bambu-lab', modelId: 'bambu-h2d', connection: 'bambu-lan' }

  it('names each missing field in plain words', () => {
    expect(testBlockers(base, bambu)).toEqual([
      { field: 'host', text: 'The IP address is empty.' },
      { field: 'accessCode', text: 'The access code is empty. It has 8 characters.' },
    ])
  })

  it('names each invalid field and what is wrong with it', () => {
    const f: PrinterForm = { ...base, fields: { ...base.fields, host: '192.168.1', serial: '12' }, secretLengths: { accessCode: 6 } }
    expect(testBlockers(f, bambu).map((b) => b.text)).toEqual([
      'The IP address "192.168.1" is not valid. Use four numbers such as 192.168.1.50.',
      'The serial number must be 8 to 24 letters and digits (Bambu Lab serials have 15).',
      'The access code has 8 characters; 6 are entered.',
    ])
    const ok: PrinterForm = { ...f, fields: { ...f.fields, host: '192.168.1.52', serial: '0948AA000000001' }, secretLengths: { accessCode: 8 } }
    expect(testBlockers(ok, bambu)).toEqual([])
    expect(checkConnection(ok, bambu).ready).toBe(true)
  })

  it('lists them beside the fields as buttons that move to the field', () => {
    const blockers = testBlockers(base, bambu)
    const r = render(createElement('div', null, createElement('input', { id: 'fr-f-accessCode' }), createElement(WhyNotReady, { blockers })))
    const items = [...r.el.querySelectorAll<HTMLButtonElement>('#fr-test-why li button')]
    expect(items.map((b) => b.textContent)).toEqual(blockers.map((b) => b.text))
    expect(r.el.querySelector('#fr-test-why')?.getAttribute('role')).toBe('status')
    items[1]!.click()
    expect(document.activeElement?.id).toBe('fr-f-accessCode')
    r.done()
  })

  it('says why in the footer, next to the disabled button, and reads it with the button', () => {
    const hint = blockerHint(testBlockers({ ...base, fields: { ...base.fields, host: '192.168.1.52', serial: '0948AA000000001' }, secretLengths: { accessCode: 6 } }, bambu))
    expect(hint).toBe('The access code has 8 characters; 6 are entered.')
    expect(blockerHint(testBlockers(base, bambu))).toBe('The IP address is empty. 1 more field needs attention above.')
    const r = render(createElement(Footer, { primary: { label: 'Test connection', onClick: () => undefined, disabled: true, hint: hint! } }))
    const button = [...r.el.querySelectorAll('button')].find((b) => b.textContent?.includes('Test connection'))!
    expect(button.getAttribute('aria-describedby')).toBe('fr-foot-hint')
    expect(r.el.querySelector('#fr-foot-hint')?.textContent).toBe(hint)
    r.done()
  })
})

describe('Bambu Lab access code, LAN Only Mode and the optional Developer Mode', () => {
  it('knows the family of each model', () => {
    expect(bambuFamily('X1 Carbon')).toBe('x1')
    expect(bambuFamily('Bambu Lab P1S')).toBe('p1')
    expect(bambuFamily('A1 mini')).toBe('a1')
    expect(bambuFamily('H2D')).toBe('h2')
    expect(bambuFamily('Voron 2.4')).toBeNull()
  })

  it('shows where the code is, LAN Only Mode for a printer out of reach, and Developer Mode as optional, per family', () => {
    const r = render(createElement(BambuLanCard, { family: 'h2', lanOnly: false }))
    const details = r.el.querySelector('details')!
    // A printer that announced cloud mode opens the card and says so.
    expect(details.open).toBe(true)
    let t = r.text()
    expect(t).toContain('This printer is in cloud mode. Enter its access code. If SlicerX can\'t reach it, turn on LAN Only Mode.')
    expect(t).toContain('open Settings, then LAN Only. The access code and the IP address are on the LAN Only page. The access code is enough to see the printer\'s status here.')
    expect(t).toContain('If SlicerX can\'t reach the printer: On the touchscreen, open Settings, then LAN Only, and turn on LAN Only Mode')
    expect(t).toContain('Direct printing (optional).')
    expect(t).toContain('turn on Developer Mode (H2D firmware 01.01.00.01 and later')
    expect(t).toContain('Without it, prints open in Bambu Connect')
    expect(t).not.toMatch(/Developer Mode first|needs? Developer Mode|requires? Developer Mode/)
    expect(t).toContain('Bambu Handy')
    // The details open on click or key, in place, not on hover.
    const more = r.el.querySelector<HTMLButtonElement>('.fr-bambu .fr-codecard-more')!
    expect(more.getAttribute('aria-expanded')).toBe('false')
    flushSync(() => more.click())
    expect(r.text()).toContain(LAN_ONLY_EFFECT)
    const a1 = [...r.el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'A1')!
    flushSync(() => a1.click())
    t = r.text()
    expect(t).toContain('open Settings, swipe to page 3, tap LAN Only Mode, and turn it on')
    expect(t).toContain('firmware 01.05.00.00 and later')
    expect(t).toContain('A1, A1 mini')
    r.done()
    expect(BAMBU_GUIDES.map((g) => g.label)).toEqual(['X1', 'P1', 'A1', 'H2'])
  })

  it('stays folded to one line until it matters', () => {
    const r = render(createElement(BambuLanCard, { family: null }))
    expect(r.el.querySelector('details')!.open).toBe(false)
    expect(r.el.querySelector('summary')?.textContent).toBe('Bambu Lab printers: where to find the access code')
    r.done()
  })

  it('no text uses dashes as punctuation', () => {
    const all = BAMBU_GUIDES.flatMap((g) => [g.lanOnly, g.developer, g.accessCode]).join(' ') + LAN_ONLY_EFFECT + DEVELOPER_EFFECT
    expect(all).not.toMatch(new RegExp('[\u2013\u2014]'))
  })
})

describe('success at each step', () => {
  it('keeps host and port apart and fills the name the printer announced', () => {
    const f = adoptFound(EMPTY_FORM, { ...FOUND, name: 'Tawain #1', address: '192.168.68.52:8883' })
    expect(f.fields.host).toBe('192.168.68.52')
    expect(f.fields.port).toBe('')
    expect(f.fields.serial).toBe('0948AA000000001')
    expect(f.name).toBe('Tawain #1')
    expect(adoptFound(EMPTY_FORM, { ...FOUND, address: '192.168.68.52:8884' }).fields.port).toBe('8884')
  })

  it('says Found it with the model and where, once a printer is picked', () => {
    expect(foundText({ ...FOUND, name: 'Tawain #1' })).toBe('Bambu Lab H2D "Tawain #1" at 192.168.1.52. Model and serial number read from the printer.')
  })

  it('says Connected with the model and both nozzles once the test passes, with an icon, not color alone', () => {
    const outcome = fromLinkResult({ ok: true, state: 'idle', steps, hardware: H2D })
    expect(connectedText(outcome, 'H2D')).toBe('H2D, left nozzle 0.6 mm and right nozzle 0.4 mm')
    const form = { ...adoptFound(EMPTY_FORM, { ...FOUND, name: 'Tawain #1' }), secretLengths: { accessCode: 8 } }
    const r = render(createElement(TestCard, { ctl: fakeCtl(form, { status: 'done', outcome }), onUseReported: () => undefined }))
    const ok = r.el.querySelector('.fr-ok')!
    expect(ok.textContent).toBe('Connected to Tawain #1: H2D, left nozzle 0.6 mm and right nozzle 0.4 mm.')
    expect(ok.getAttribute('role')).toBe('status')
    expect(ok.querySelector('svg')).not.toBeNull()
    expect([...r.el.querySelectorAll('.fr-step-word')].map((e) => e.textContent)).toEqual(['Done', 'Done', 'Done', 'Done'])
    r.done()
  })
})

function fakeCtl(form: PrinterForm, test: PrinterController['test']): PrinterController {
  const noop = () => undefined
  return { form, test, method: form.connection ? connectionMethod(form.connection) : null, setForm: noop, setSecret: noop, runTest: async () => undefined, cancelTest: noop, testFrom: async () => null, scan: { status: 'idle' }, runScan: async () => undefined, addFound: noop, field: null, setField: noop, save: async () => { throw new Error('no') }, saveFrom: async () => { throw new Error('no') }, current: () => form, reset: noop, keepReported: null, setKeepReported: noop, host: {} as PrinterController['host'] }
}

describe('a failed test in plain words', () => {
  const ctx = { address: '192.168.68.52', family: 'bambu-lan', model: 'H2D' }
  const fail = (o: Partial<Parameters<typeof fromLinkResult>[0]>) => fromLinkResult({ ok: false, steps: steps.map((s) => ({ ...s, ok: s.id === 'reach' ? false : null })), ...o })

  it('certificate trouble is our problem, with a report and an update', () => {
    const c = failureCopy(fail({ cause: 'unreachable', kind: 'tls', message: 'TLS: I/O: invalid peer certificate: UnknownIssuer' }), ctx)
    expect(c.title).toBe("SlicerX couldn't confirm this is your printer.")
    expect(c.body).toContain('The problem is in SlicerX, not your network.')
    expect(c.actions).toEqual(['report', 'update'])
  })

  it('a refused code says where the code is on that family, and offers a retry', () => {
    const c = failureCopy(fail({ cause: 'auth', kind: 'auth' }), ctx)
    expect(c.title).toBe("The access code didn't work.")
    expect(c.tips[0]).toBe('The access code and the IP address are on the LAN Only page.')
    expect(c.actions).toEqual(['retry'])
  })

  it('a refused Moonraker sign-in says which of the three it was', () => {
    const klipper = { address: '192.168.68.60', family: 'moonraker' }
    const words = (authNeed: string) => failureCopy(fail({ cause: 'auth', kind: 'auth', authNeed }), klipper)
    expect(words('not_trusted').title).toBe("The printer doesn't trust this computer.")
    expect(words('not_trusted').tips.join(' ')).toContain('trusted_clients')
    expect(words('key_wrong').title).toBe("The printer didn't accept the API key.")
    expect(words('login_required').title).toBe('The printer asks for a user login.')
    expect(words('login_required').actions).toEqual(['retry'])
    // Without a reason, or one this app does not know, the plain words stay.
    expect(words('something new').title).toBe("The printer didn't accept the key.")
  })

  it('no answer names the address and gives one thing to try: LAN Only Mode, with the family\'s path', () => {
    for (const [cause, kind] of [['timeout', 'timeout'], ['unreachable', 'other']] as const) {
      const c = failureCopy(fail({ cause, kind }), ctx)
      expect(c.title).toBe('No answer from 192.168.68.52.')
      expect(c.body).toBe('Check the printer is on and on the same network as this computer.')
      expect(c.tips).toEqual(['Turn on LAN Only Mode on the printer, then test again. On the touchscreen, open Settings, then LAN Only, and turn on LAN Only Mode. Turn on LAN Only Liveview too if you want the camera.'])
      expect(c.tips.join(' ')).not.toContain('Developer Mode')
    }
    // Every failure the setup panel can show leaves Developer Mode out: connecting never needs it.
    for (const kind of ['tls', 'auth', 'timeout', 'other'] as const) {
      const c = failureCopy(fail({ cause: kind === 'auth' ? 'auth' : 'unreachable', kind }), ctx)
      expect(`${c.title} ${c.body} ${c.tips.join(' ')}`, kind).not.toContain('Developer Mode')
    }
    expect(Object.values(FAILURE_HELP).map((h) => `${h.title} ${h.cause} ${h.action}`).join(' ')).not.toContain('Developer Mode')
  })

  it('anything else gets one plain sentence and a report', () => {
    const c = failureCopy(fail({ cause: 'protocol', kind: 'other' }), ctx)
    expect(c.kind).toBe('other')
    expect(c.actions).toContain('report')
  })

  it('keys off the kind, not the message, and keeps the raw text out of the panel', () => {
    expect(failureKind(fail({ cause: 'unreachable', message: 'certificate expired' }))).toBe('no-answer')
    const raw = 'TLS: I/O: invalid peer certificate: UnknownIssuer'
    const outcome = fail({ cause: 'unreachable', kind: 'tls', message: raw, details: raw, certificate: { verified: false, detail: 'issuer unknown' } })
    const form = adoptFound(EMPTY_FORM, FOUND)
    const r = render(createElement(TestCard, { ctl: fakeCtl(form, { status: 'done', outcome }), onUseReported: () => undefined }))
    expect(r.text()).not.toContain('invalid peer certificate')
    expect(r.text()).not.toMatch(/sign_in|not reached/)
    expect(r.text()).toContain('Failed')
    const report = [...r.el.querySelectorAll('button')].find((b) => b.textContent === 'Send a report')!
    flushSync(() => report.click())
    expect(get().bugReportOpen).toBe(true)
    expect(get().bugReportDraft?.happened).toContain(`Details: ${raw}`)
    expect(get().bugReportDraft?.happened).toContain('Certificate: not verified (issuer unknown)')
    set({ bugReportOpen: false, bugReportDraft: null })
    r.done()
  })
})

describe('where the access code is, drawn on the printer screen', () => {
  it('walks each family\'s path from Bambu Lab\'s wiki to the access code', () => {
    const paths: Record<string, string> = { x1: 'Settings > LAN Only', p1: 'Settings > WLAN > LAN Only Mode', a1: 'Settings > Page 3 > LAN Only Mode', h2: 'Settings > LAN Only' }
    for (const g of BAMBU_GUIDES) {
      const r = render(createElement(AccessCodeScreen, { family: g.family }))
      const svg = r.el.querySelector('svg')!
      expect(svg.getAttribute('role')).toBe('img')
      expect(svg.getAttribute('aria-label')).toContain('The access code is on that page')
      expect(r.el.querySelector('figcaption')?.textContent).toBe(`${paths[g.family]} > access code`)
      expect(r.el.querySelectorAll('.fr-ac-hot').length).toBe(g.path.length)
      r.done()
    }
  })
})

describe('the model grid', () => {
  const dir = resolve(__dirname, '../../profiles/printer-images')
  const files = readdirSync(dir).filter((f) => f.endsWith('.webp')).map((f) => f.slice(0, -5)).sort()

  it('every catalog printer resolves to a picture or the placeholder, never a broken image', () => {
    for (const m of PRINTER_MODELS) {
      const r = render(createElement(PrinterPicture, { model: m, brand: 'Brand' }))
      const img = r.el.querySelector('img')
      if (IMAGE_IDS.has(m.id)) {
        expect(files, m.id).toContain(m.id)
        expect(img?.getAttribute('alt')).toBe(`Brand ${m.name}`)
        expect(img?.getAttribute('loading')).toBe('lazy')
        expect(printerImage(m.id)).toMatch(/printer-images\/.+\.webp$/)
      } else {
        expect(img, m.id).toBeNull()
        expect(r.el.querySelector('[data-empty] svg'), m.id).not.toBeNull()
        expect(printerImage(m.id)).toBeNull()
      }
      r.done()
    }
  })

  it('lists exactly the pictures in the folder, each a catalog printer, each small', () => {
    expect([...IMAGE_IDS].sort()).toEqual(files)
    const ids = new Set(PRINTER_MODELS.map((m) => m.id))
    for (const f of files) {
      expect(ids.has(f), f).toBe(true)
      expect(statSync(resolve(dir, `${f}.webp`)).size, f).toBeLessThan(30_000)
    }
    // Every Bambu Lab printer has one.
    expect(PRINTER_MODELS.filter((m) => m.brand === 'bambu-lab' && !IMAGE_IDS.has(m.id))).toEqual([])
  })

  it('falls back to the placeholder when a picture fails to load', () => {
    const m = PRINTER_MODELS.find((x) => x.id === 'bambu-h2d')!
    const r = render(createElement(PrinterPicture, { model: m, brand: 'Bambu Lab' }))
    flushSync(() => r.el.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(r.el.querySelector('img')).toBeNull()
    expect(r.el.querySelector('[data-empty]')).not.toBeNull()
    r.done()
  })
})

describe('both nozzles of a two nozzle printer', () => {
  it('are kept in the printer record, left first', () => {
    const f = withHardware(adoptFound(EMPTY_FORM, FOUND), H2D)
    expect(extruderNozzles(f)).toEqual([
      { mm: 0.6, type: 'hardened-steel', highFlow: true },
      { mm: 0.4, type: 'hardened-steel' },
    ])
    expect(extruderNozzles(withHardware(adoptFound(EMPTY_FORM, { ...FOUND, model: 'A1' }), { extruders: [{ tool: 0, nozzleDiameterMm: 0.4 }] }))).toBeNull()
  })

  it('reach the slicing profile as each extruder\'s diameter and type', async () => {
    const { applyExtruders } = await import('../src/adapters/profile')
    const machine: Record<string, import('@slicerx/contracts').SettingValue> = { nozzle_diameter: [0.4, 0.4], nozzle_type: ['hardened_steel,hardened_steel'] }
    applyExtruders(machine, [{ mm: 0.6, type: 'hardened-steel' }, { mm: 0.4, type: 'stainless-steel' }])
    expect(machine['nozzle_diameter']).toEqual([0.6, 0.4])
    expect(machine['nozzle_type']).toEqual(['hardened_steel,stainless_steel'])
    // A one nozzle machine is left alone.
    const one: Record<string, import('@slicerx/contracts').SettingValue> = { nozzle_diameter: [0.4] }
    applyExtruders(one, [{ mm: 0.6 }, { mm: 0.4 }])
    expect(one['nozzle_diameter']).toEqual([0.4])
  })

  it('survive a restart', async () => {
    const { normalizePrefs } = await import('../src/state/prefs')
    const kept = [{ mm: 0.6, type: 'hardened-steel', highFlow: true }, { mm: 0.4 }]
    expect(normalizePrefs({ printerExtruders: { 'bambu-h2d': kept } }).printerExtruders).toEqual({ 'bambu-h2d': kept })
    // A size out of range is not trusted.
    expect(normalizePrefs({ printerExtruders: { 'bambu-h2d': [...kept, { mm: 9 }] } }).printerExtruders).toEqual({})
  })
})

describe('what the first report says before a print is tried', () => {
  it('says prints go through Bambu Connect, as a note and not a warning, when the printer wants signed commands', () => {
    const form = withHardware(adoptFound(EMPTY_FORM, FOUND), H2D)
    const r = render(createElement(ConfirmCard, { form, setForm: () => undefined, hardware: { ...H2D, developerMode: false }, reportedNozzle: true }))
    expect(r.el.querySelector('[role="alert"]')).toBeNull()
    const note = r.el.querySelector('.fr-info-box[role="status"]')!
    expect(note.textContent).toContain('Prints go through Bambu Connect.')
    expect(note.textContent).toContain('SlicerX shows this printer\'s status, and prints open in Bambu Connect')
    // Developer Mode stays folded under direct printing until asked for.
    expect(note.textContent).not.toContain('Developer Mode')
    const more = note.querySelector<HTMLButtonElement>('button')!
    expect(more.textContent).toBe('Direct printing (optional)')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    flushSync(() => more.click())
    expect(note.textContent).toContain('To print straight from SlicerX, turn on LAN Only Mode and then Developer Mode.')
    expect(note.textContent).toContain('H2D firmware 01.01.00.01 and later')
    expect(note.textContent).toContain('open Settings, then LAN Only.')
    r.done()
    const ok = render(createElement(ConfirmCard, { form, setForm: () => undefined, hardware: H2D, reportedNozzle: true }))
    expect(ok.el.querySelector('[role="alert"]')).toBeNull()
    expect(ok.text()).toContain('Micro SD card in')
    ok.done()
  })

  it('gives each series its own way to Developer Mode', () => {
    const where: Record<string, string> = { 'A1 mini': 'swipe to page 3 and tap LAN Only Mode', P1S: 'open Settings, then WLAN.', 'X1 Carbon': 'open Settings, then LAN Only.' }
    for (const [model, path] of Object.entries(where)) {
      const form = adoptFound(EMPTY_FORM, { ...FOUND, model })
      const r = render(createElement(ConfirmCard, { form, setForm: () => undefined, hardware: { model, developerMode: false }, reportedNozzle: false }))
      flushSync(() => r.el.querySelector<HTMLButtonElement>('.fr-info-box button')!.click())
      expect(r.el.querySelector('.fr-info-box')!.textContent).toContain(path)
      r.done()
    }
  })

  it('tells an X1 owner to put a micro SD card in', () => {
    const form = adoptFound(EMPTY_FORM, { ...FOUND, model: 'X1 Carbon' })
    const r = render(createElement(ConfirmCard, { form, setForm: () => undefined, hardware: { model: 'X1 Carbon', sdCard: false, developerMode: true }, reportedNozzle: false }))
    expect(r.el.querySelector('[role="alert"]')?.textContent).toContain('Put a micro SD card in the printer.')
    r.done()
  })
})
