// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes an HTML contact sheet of every logo: node scripts/sheet.mjs <output.html>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = process.argv[2]
if (!out) {
  console.error('usage: node scripts/sheet.mjs <output.html>')
  process.exit(1)
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/logos')
const logos = readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => {
    const src = readFileSync(join(dir, f), 'utf8')
      .replace(/^import .*$/gm, '')
      .replace(/export const \w+: BrandLogoRecord =/, 'return')
    return new Function(src)()
  })

const svg = (l, mono) => {
  const art = mono ? l.svg : (l.colorSvg ?? l.svg)
  const fill = mono ? 'currentColor' : l.colorSvg ? 'none' : l.color
  const attr = mono || !l.colorSvg ? ` fill="${fill}"` : ''
  return `<svg width="32" height="32" viewBox="${l.viewBox}"${attr} aria-hidden="true">${art}</svg>`
}
const rows = logos
  .map(
    (l) => `<div class="row"><div class="mono">${svg(l, true)}</div><div class="color">${svg(l, false)}</div><div class="meta"><b>${l.title}</b><span>${l.slug} ${l.color}</span><span>${l.license}</span></div></div>`,
  )
  .join('\n')
writeFileSync(
  out,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Brand logos</title><style>
body{margin:0;padding:24px;background:#121319;color:#a9afd0;font:13px system-ui,sans-serif}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.row{display:flex;align-items:center;gap:14px;padding:10px;border:1px solid #23252f;border-radius:8px}
.mono,.color{width:56px;height:56px;display:flex;align-items:center;justify-content:center;border-radius:6px}
.mono{background:#121319;color:#a9afd0;border:1px solid #23252f}
.color{background:#fff}
.meta{display:flex;flex-direction:column;gap:2px}.meta span{opacity:.7;font-size:11px}
</style></head><body><div class="grid">
${rows}
</div></body></html>`,
)
console.log(`wrote ${logos.length} logos to ${out}`)
