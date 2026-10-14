// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Snaps the 16 px tool icons to whole pixels: draws each 16 px drawing in a browser a quarter pixel down (so a 2:1 edge
// splits 75/25 and every column picks one pixel), gives each pixel the nearest palette color or none, and writes the
// result as runs of whole pixels per color class to icons/tool/snapped16.json. Run it after changing a 16 px drawing,
// then gen-tool-icons.mjs. Run: node packages/ui/scripts/snap-tool-icons.mjs
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const tool = resolve(here, '../icons/tool')
const { ICONS } = await import(pathToFileURL(resolve(tool, 'draw.mjs')).href)
const { TOOL_ICON_CSS, SNAP_PALETTE } = await import(pathToFileURL(resolve(tool, 'css.mjs')).href)

const P = SNAP_PALETTE
const vars = `--ti-t1:${P.t1};--ti-t2:${P.t2};--ti-t3:${P.t3};--ti-a1:${P.a1};--ti-a2:${P.a2};--ti-a3:${P.a3};--ti-ol:${P.po};--ti-aol:${P.pa};--ti-hl:${P.hl};--ti-sk:${P.skf};--ti-skc:${P.skcf};--ti-nd:${P.nd};--ti-hi:transparent;--ti-sh:transparent;--ti-sh3:transparent`
const drawings = Object.fromEntries(Object.keys(ICONS).map((k) => [k, ICONS[k](16)]))

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const out = await page.evaluate(async ({ drawings, css, vars, palette }) => {
    const pal = Object.entries(palette).map(([k, h]) => [k, parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)])
    const snap = (k) => new Promise((ok, fail) => {
      const img = new Image()
      img.onerror = () => fail(new Error(`could not draw ${k}`))
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = 16
        c.height = 16
        const g = c.getContext('2d')
        g.drawImage(img, 0, 0)
        const d = g.getImageData(0, 0, 16, 16).data
        const runs = {}
        for (let y = 0; y < 16; y++) {
          let cur = null
          let x0 = 0
          for (let x = 0; x <= 16; x++) {
            let cls = null
            if (x < 16) {
              const i = (y * 16 + x) * 4
              const a = d[i + 3]
              if (a >= 110) {
                const r = (d[i] * 255) / a, gg = (d[i + 1] * 255) / a, b = (d[i + 2] * 255) / a
                let best = Infinity
                for (const [name, pr, pg, pb] of pal) {
                  const e = (r - pr) ** 2 * 0.3 + (gg - pg) ** 2 * 0.59 + (b - pb) ** 2 * 0.11
                  if (e < best) {
                    best = e
                    cls = name
                  }
                }
              }
            }
            if (cls !== cur) {
              if (cur) (runs[cur] ??= []).push(`M${x0} ${y}h${x - x0}v1h-${x - x0}z`)
              cur = cls
              x0 = x
            }
          }
        }
        ok(Object.entries(runs).map(([c2, r]) => `<path class="${c2} nos px" d="${r.join('')}"/>`).join(''))
      }
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" class="ti" viewBox="0 0 16 16" width="16" height="16" style="${vars}"><style>${css}</style><g transform="translate(0 0.25)">${drawings[k]}</g></svg>`)
    })
    const result = {}
    for (const k of Object.keys(drawings)) result[k] = await snap(k)
    return result
  }, { drawings, css: TOOL_ICON_CSS, vars, palette: P })
  writeFileSync(resolve(tool, 'snapped16.json'), JSON.stringify(out, null, 1) + '\n')
  console.log(`snapped ${Object.keys(out).length} icons`)
} finally {
  await browser.close()
}
