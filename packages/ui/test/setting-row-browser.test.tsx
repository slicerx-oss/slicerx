// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings rows on a phone in a real browser, at 390 px: the kit's rows (SettingRow with a number, two segmented
// choices, one set to fill its box and one not, and a switch) rendered to markup, the kit's own styles, and the group
// decision run on the page. When one label is too long to sit beside its control, the whole group stacks and each
// segmented choice runs under its label from the label's x to the controls' right edge. When every label fits, the
// group stays inline and each segmented choice keeps its own width beside its label. Without Chromium for playwright it
// fails under CI and skips, with a console line, elsewhere.
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { Seg, Switch } from '../src/components/seg'
import { groupStacks, INLINE_LABEL_LINES, labelFit, layOutGroup, SETROWS_ATTR, SettingRow } from '../src/components/setting-row'

const ORIGIN = 'http://kit.test'
const SRC = resolve(import.meta.dirname, '../src')
const TYPES: Record<string, string> = { '.css': 'text/css', '.html': 'text/html' }

const noop = () => undefined

/** One list of rows: a number, a segmented choice set to fill its box and one at its own width, and a switch, under the given first label. */
function list(id: string, first: string): string {
  return renderToStaticMarkup(
    <ul id={id} className="rows">
      <SettingRow as="li" label={<label>{first}</label>} control={<input className="num" defaultValue="0.8" />} />
      <SettingRow as="li" label={<label>Wipe</label>} control={<Seg label="Wipe" size="sm" full value="off" onChange={noop} options={[{ value: 'off', label: 'Off' }, { value: 'tower', label: 'Tower' }, { value: 'part', label: 'Part' }]} />} />
      <SettingRow as="li" label={<label>Ooze</label>} control={<Seg label="Ooze" size="sm" value="on" onChange={noop} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />} />
      <SettingRow as="li" label={<label>Firmware retraction</label>} control={<Switch id="fw" checked={false} onChange={noop} label="Firmware retraction" />} />
    </ul>,
  )
}

// The page lays its groups out with the kit's own functions, as SettingRow does before the first paint.
const PAGE = `<!doctype html>
<html lang="en" data-phone><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles.css"><style>
  #host { width: 358px; margin: 0 16px; }
  .rows { list-style: none; margin: 0 0 24px; padding: 0; }
  .rows .num { width: 80px; height: 44px; }
</style></head><body><div id="host">
${list('cramped', 'Retraction length when the active extruder changes before a tool change')}
${list('fits', 'Retraction length')}
</div><script>
const INLINE_LABEL_LINES = ${INLINE_LABEL_LINES}
const SETROWS_ATTR = ${JSON.stringify(SETROWS_ATTR)}
const groupStacks = ${groupStacks.toString()}
const labelFit = ${labelFit.toString()}
const layOutGroup = ${layOutGroup.toString()}
document.fonts.ready.then(() => {
  for (const g of document.querySelectorAll('.rows')) layOutGroup(g)
  window.ready = true
})
</script></body></html>`

type Box = { left: number; right: number; top: number; bottom: number; width: number }
type Row = { kind: 'seg' | 'switch' | 'other'; label: Box; ctl: Box; edge: number }

let browser: Browser | null = null
let page: Page | null = null

beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) {
    if (process.env.CI) throw new Error(`No Chromium for playwright at ${chromium.executablePath()}: install it in this CI job (pnpm --filter @slicerx/web exec playwright install chromium)`)
    console.log('setting-row-browser: skipped, no Chromium for playwright on this machine')
    return
  }
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: PAGE })
    const file = join(SRC, decodeURIComponent(path.replace(/^\/src\//, '')))
    if (!path.startsWith('/src/') || !file.startsWith(SRC) || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, null, { timeout: 15_000 }).catch(() => {
    throw new Error(`the page did not load: ${errors.join('; ')}`)
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

/** The group's layout and each row's label and control boxes, with the right edge a control ends at (the reset rail's left, less the gap). */
const read = (id: string) =>
  page!.evaluate((id) => {
    const g = document.getElementById(id)!
    const box = (e: Element) => {
      const r = e.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }
    }
    const rows = [...g.children].map((r) => {
      const [, label, ctl, reset] = [...r.children]
      return {
        kind: ctl!.classList.contains('sx-seg') ? 'seg' : ctl!.classList.contains('sx-switch') ? 'switch' : 'other',
        label: box(label!),
        ctl: box(ctl!),
        edge: reset!.getBoundingClientRect().left - parseFloat(getComputedStyle(r).columnGap),
      }
    })
    return { layout: g.getAttribute('data-setrows'), rows }
  }, id) as Promise<{ layout: string | null; rows: Row[] }>

const beside = (r: Row) => r.ctl.top < r.label.bottom && r.ctl.bottom > r.label.top

describe('a segmented row in a group of settings rows, in a browser at 390 px', () => {
  it('stacks with the whole group when another label is cramped, and runs full width under its label', async (ctx) => {
    if (!page) return ctx.skip()
    const { layout, rows } = await read('cramped')
    expect(layout).toBe('stack')
    const x = rows[0]!.label.left
    for (const r of rows) {
      expect(Math.abs(r.label.left - x), r.kind).toBeLessThanOrEqual(0.5)
      expect(Math.abs(r.ctl.right - r.edge), r.kind).toBeLessThanOrEqual(0.5)
    }
    const [num, seg, own, sw] = rows as [Row, Row, Row, Row]
    // the number sits under its label at its own width against the edge
    expect(num.ctl.top - num.label.bottom).toBeGreaterThanOrEqual(3.5)
    expect(num.ctl.width).toBeLessThan(num.edge - x)
    // the segmented choice: under its label, from the label's x to the edge
    expect(seg.kind).toBe('seg')
    expect(seg.ctl.top - seg.label.bottom).toBeGreaterThanOrEqual(3.5)
    expect(seg.ctl.top - seg.label.bottom).toBeLessThanOrEqual(12)
    expect(Math.abs(seg.ctl.left - x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(seg.ctl.width - (seg.edge - x))).toBeLessThanOrEqual(0.5)
    // so does one that keeps its own width elsewhere
    expect(own.kind).toBe('seg')
    expect(own.ctl.top - own.label.bottom).toBeGreaterThanOrEqual(3.5)
    expect(Math.abs(own.ctl.left - x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(own.ctl.width - (own.edge - x))).toBeLessThanOrEqual(0.5)
    // a switch stays beside its label
    expect(sw.kind).toBe('switch')
    expect(beside(sw)).toBe(true)
  }, 30_000)

  it('stays inline when every label fits, the segmented choice at its own width beside its label', async (ctx) => {
    if (!page) return ctx.skip()
    const { layout, rows } = await read('fits')
    expect(layout).toBe('inline')
    for (const seg of [rows[1]!, rows[2]!]) {
      expect(seg.kind).toBe('seg')
      expect(beside(seg)).toBe(true)
      expect(seg.ctl.left - seg.label.right).toBeGreaterThanOrEqual(0)
    }
    for (const r of rows) expect(beside(r), r.kind).toBe(true)
  }, 30_000)
})
