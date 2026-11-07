// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A disabled primary Button in a real browser, in the dark and the light theme: the kit's own styles and the theme's
// tokens, the cascade as the page gets it. It drops the accent fill for the disabled field's gray, with the disabled
// field's line and the dim label, at full opacity, so a faded accent never passes for an enabled button, and hover or
// the first-run gradient do not bring the accent back. Its label keeps 4.5:1 on its fill, and its fill sits clear of
// the accent's. The enabled primary keeps the accent fill and the dark label. A split primary whose main half waits keeps
// its menu half pressable, in the plain button look. Without Chromium for playwright it fails
// under CI and skips, with a console line, elsewhere.
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { Button } from '../src/components/button'
import { SplitButton } from '../src/components/split-button'
import { subban, themeToCss } from '../src/theme'
import { subbanLight } from '../src/themes'

const ORIGIN = 'http://kit.test'
const SRC = resolve(import.meta.dirname, '../src')
const FIRST_RUN = resolve(import.meta.dirname, '../../app/src/first-run/first-run.css')
const TYPES: Record<string, string> = { '.css': 'text/css', '.html': 'text/html' }

const noop = () => undefined

/** The four variants, enabled and disabled, the soft-disabled one a tip keeps hoverable, and the first-run footer's primary. */
const buttons = renderToStaticMarkup(
  <div id="host">
    {(['default', 'primary', 'ghost', 'danger'] as const).map((v) => (
      <div key={v}>
        <Button variant={v} id={`${v}-on`} onClick={noop}>Label</Button>
        <Button variant={v} id={`${v}-off`} disabled>Label</Button>
        <Button variant={v} id={`${v}-soft`} disabled tip="Why it waits">Label</Button>
      </div>
    ))}
    <div>
      <SplitButton variant="primary" id="sp-on" menuLabel="More" menuOpen={false} onMenu={noop} menuProps={{ id: 'sp-on-menu' }} onClick={noop}>Print</SplitButton>
      <SplitButton variant="primary" id="sp-off" menuLabel="More" menuOpen={false} onMenu={noop} menuProps={{ id: 'sp-off-menu' }} disabled>Print</SplitButton>
      <SplitButton variant="primary" id="sp-soft" menuLabel="More" menuOpen={false} onMenu={noop} menuProps={{ id: 'sp-soft-menu' }} disabled tip="Why it waits">Print</SplitButton>
    </div>
    <div className="fr">
      <Button variant="primary" className="fr-primary" id="fr-on" onClick={noop}>Label</Button>
      <Button variant="primary" className="fr-primary" id="fr-off" disabled>Label</Button>
    </div>
  </div>,
)

const pageFor = (theme: 'dark' | 'light') => `<!doctype html>
<html lang="en"${theme === 'light' ? ' data-scheme="light"' : ''}><head><meta charset="utf-8"><link rel="stylesheet" href="/src/tokens.css"><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/first-run.css">
<style>${themeToCss(theme === 'dark' ? subban : subbanLight)}</style>
<style>* { transition: none !important; }
body { margin: 0; background: var(--ink-1); color: var(--fg); } #host { padding: 16px; background: var(--ink-1); } #host > div { display: flex; gap: 8px; margin-bottom: 8px; }</style>
</head><body>${buttons}<i id="tokens" style="background: color-mix(in srgb, var(--ink-3) 40%, transparent); color: ${theme === 'light' ? 'color-mix(in srgb, var(--field-dim) 75%, transparent)' : 'color-mix(in srgb, var(--field-dim) 88%, var(--ink-3))'}; border: 1px solid color-mix(in srgb, var(--line) 50%, transparent)"></i><b id="accent" style="background: var(--accent); color: var(--on-grad)"></b></body></html>`

let browser: Browser | null = null
let pages: Record<'dark' | 'light', Page> | null = null
let page: Page | null = null

beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) {
    if (process.env.CI) throw new Error(`No Chromium for playwright at ${chromium.executablePath()}: install it in this CI job (pnpm --filter @slicerx/web exec playwright install chromium)`)
    console.log('button-disabled: skipped, no Chromium for playwright on this machine')
    return
  }
  browser = await chromium.launch({ headless: true })
  const open = async (theme: 'dark' | 'light') => {
  const p = await browser!.newPage({ viewport: { width: 600, height: 400 } })
  await p.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: pageFor(theme) })
    if (path === '/first-run.css') return route.fulfill({ contentType: 'text/css', body: readFileSync(FIRST_RUN) })
    const file = join(SRC, decodeURIComponent(path.replace(/^\/src\//, '')))
    if (!path.startsWith('/src/') || !file.startsWith(SRC) || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
  })
  await p.goto(`${ORIGIN}/`)
  return p
  }
  pages = { dark: await open('dark'), light: await open('light') }
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

type Look = { bg: string; fg: string; line: string; image: string; opacity: string; cursor: string }
type Seen = { disabled: Look; hovered: Look; enabled: Look; accent: Look; plain: Look; normal: Look; back: Look }

/** A button's painted look, as computed on the page, every color as 0 to 255 sRGB. */
const look = async (id: string): Promise<Look> => {
  const raw = await page!.evaluate((id) => {
    const cs = getComputedStyle(document.getElementById(id)!)
    return { bg: cs.backgroundColor, fg: cs.color, line: cs.borderTopColor, image: cs.backgroundImage, opacity: cs.opacity, cursor: cs.cursor }
  }, id)
  return { ...raw, bg: srgb(raw.bg), fg: srgb(raw.fg), line: srgb(raw.line) }
}

/** The page's computed colors come as rgb(), color(srgb ...) or oklab() (a color-mix): all of them as rgba(r, g, b, a) on 0 to 255. */
function srgb(c: string): string {
  const nums = (c.match(/-?[\d.]+(?:e-?\d+)?%?/g) ?? []).map((n) => (n.endsWith('%') ? parseFloat(n) / 100 : parseFloat(n)))
  let rgb: number[]
  let a = nums[3] ?? 1
  if (c.startsWith('oklab')) {
    const [L, A, B] = nums as [number, number, number]
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    const sx = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sx, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sx, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * sx]
    rgb = lin.map((v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055))
  } else if (c.startsWith('color(')) {
    rgb = nums.slice(0, 3).map((v) => v * 255)
    a = nums[3] ?? 1
  } else rgb = nums.slice(0, 3)
  return `rgba(${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v)))).join(', ')}, ${Math.round(a * 100) / 100})`
}

/** Reads what the tests compare from the theme's page: a disabled button, with the pointer on it, and the enabled one. */
async function seen(theme: 'dark' | 'light', id: string): Promise<Seen> {
  page = pages![theme]
  await page.bringToFront()
  const disabled = await look(`${id}-off`)
  const box = (await (await page!.$(`#${id}-off`))!.boundingBox())!
  await page!.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const hovered = await look(`${id}-off`)
  await page!.mouse.move(0, 0)
  return { disabled, hovered, enabled: await look(`${id}-on`), accent: await look('accent'), plain: await look('tokens'), normal: await look('default-on'), back: await look('host') }
}

/** rgba text from the page to [r, g, b] 0 to 255 (the colors here are opaque). */
function rgb(c: string): [number, number, number] {
  const m = c.match(/[\d.]+/g)!.map(Number)
  return [m[0]!, m[1]!, m[2]!]
}
/** A color with alpha over an opaque one, as rgb text. */
function over(top: string, back: string): string {
  const m = top.match(/[\d.]+/g)!.map(Number)
  const b = rgb(back)
  const a = m[3] ?? 1
  return `rgb(${[0, 1, 2].map((i) => m[i]! * a + b[i]! * (1 - a)).join(', ')})`
}
function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe.each(['dark', 'light'] as const)('a disabled primary Button in the %s theme', (theme) => {
  const pressable = (id: string) => page!.evaluate((id) => !(document.getElementById(id) as HTMLButtonElement).disabled && document.getElementById(id)!.getAttribute('aria-disabled') !== 'true', id)

  it('takes the recessive disabled look at full opacity, with no accent and no gradient, and hover leaves it alone', async (ctx) => {
    if (!pages) return ctx.skip()
    const s = await seen(theme, 'primary')
    expect(s.disabled.bg).toBe(s.plain.bg)
    expect(s.disabled.line).toBe(s.plain.line)
    expect(s.disabled.fg).toBe(s.plain.fg)
    expect(s.disabled.opacity).toBe('1')
    expect(s.disabled.image).toBe('none')
    expect(s.disabled.cursor).toBe('not-allowed')
    expect(s.hovered).toEqual(s.disabled)
  }, 30_000)

  it('keeps its label legible (4.5:1 in dark, about 3:1 in light) and reads as recessive next to an enabled default and an enabled primary', async (ctx) => {
    if (!pages) return ctx.skip()
    const s = await seen(theme, 'primary')
    const fill = over(s.disabled.bg, s.back.bg)
    // dark keeps 4.5:1; light drops to about 3:1 so the label sits below an enabled quiet button's
    const label = ratio(over(s.disabled.fg, fill), fill)
    if (theme === 'dark') expect(label).toBeGreaterThanOrEqual(4.5)
    else {
      expect(label).toBeGreaterThanOrEqual(2.8)
      expect(label).toBeLessThanOrEqual(3.6)
    }
    // a fill other than the enabled default's, a softer line, and a label with less contrast than its label has
    expect(fill).not.toBe(over(s.normal.bg, s.back.bg))
    expect(over(s.disabled.line, s.back.bg)).not.toBe(over(s.normal.line, s.back.bg))
    expect(label).toBeLessThan(ratio(s.normal.fg, over(s.normal.bg, s.back.bg)))
    expect(ratio(fill, s.enabled.bg)).toBeGreaterThanOrEqual(1.5)
  }, 30_000)

  it('leaves the enabled primary as it was: the accent fill, the dark label, a clear line, full opacity', async (ctx) => {
    if (!pages) return ctx.skip()
    const s = await seen(theme, 'primary')
    expect(s.enabled.bg).toBe(s.accent.bg)
    expect(s.enabled.fg).toBe(s.accent.fg)
    expect(s.enabled.line).toBe('rgba(0, 0, 0, 0)')
    expect(s.enabled.opacity).toBe('1')
  }, 30_000)

  it('treats the soft-disabled primary (a tip keeps it hoverable) like the disabled one', async (ctx) => {
    if (!pages) return ctx.skip()
    const s = await seen(theme, 'primary')
    const soft = await look('primary-soft')
    expect(soft).toEqual(s.disabled)
  }, 30_000)

  it('is not brought back by the first-run footer primary, whose enabled look is a gradient', async (ctx) => {
    if (!pages) return ctx.skip()
    const s = await seen(theme, 'fr')
    expect(s.enabled.image).toContain('gradient')
    expect(s.disabled.image).toBe('none')
    expect(s.disabled.bg).toBe(s.plain.bg)
    expect(s.hovered).toEqual(s.disabled)
  }, 30_000)

  it('shows the menu half of a split primary as an enabled default, pressable, while its main half waits', async (ctx) => {
    if (!pages) return ctx.skip()
    const s = await seen(theme, 'primary')
    const [mainOn, menuOn] = [await look('sp-on'), await look('sp-on-menu')]
    expect(menuOn).toEqual({ ...mainOn, cursor: menuOn.cursor, line: menuOn.line })
    for (const id of ['sp-off', 'sp-soft']) {
      const [main, menu] = [await look(id), await look(`${id}-menu`)]
      expect(main.bg, id).toBe(s.disabled.bg)
      expect(await pressable(`${id}-menu`), id).toBe(true)
      // the enabled default's fill, line and label, no more prominent than that, and not the main half's look
      expect(menu.bg, id).toBe(s.normal.bg)
      expect(menu.fg, id).toBe(s.normal.fg)
      expect(menu.line, id).toBe(s.normal.line)
      expect(menu.opacity, id).toBe('1')
      expect(menu.fg, id).not.toBe(main.fg)
    }
  }, 30_000)
})
