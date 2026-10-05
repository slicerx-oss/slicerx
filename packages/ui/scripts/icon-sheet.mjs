// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes a contact sheet of every icon at 24px and 48px, grouped, 12 per row, for design review.
// Reads the generated src/icons/icon-paths.ts, so run scripts/gen-icons.mjs first.
// Usage: node packages/ui/scripts/icon-sheet.mjs <out.html>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = process.argv[2]
if (!out) {
  console.error('usage: icon-sheet.mjs <out.html>')
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const ts = readFileSync(resolve(here, '../src/icons/icon-paths.ts'), 'utf8')
// The generated file is plain object literals; strip the TypeScript parts and evaluate them.
const body = ts
  .replace(/^export type .*$/m, '')
  .replace(/ as const/g, '')
  .replace(/: Readonly<Record<string, readonly IconName\[\]>>/g, '')
  .replace(/export const /g, 'const ')
const { ICON_PATHS, ICON_GROUPS } = new Function(body + '\nreturn { ICON_PATHS, ICON_GROUPS };')()

const svg = (inner, size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`

const sections = Object.entries(ICON_GROUPS)
  .map(
    ([group, names]) => `<section><h2>${group} <span>${names.length}</span></h2><div class="grid">${names
      .map((n) => `<figure><div class="pair">${svg(ICON_PATHS[n], 24)}${svg(ICON_PATHS[n], 48)}</div><figcaption>${n}</figcaption></figure>`)
      .join('')}</div></section>`,
  )
  .join('\n')

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SlicerX icons</title>
<style>
  body { margin: 0; padding: 24px; background: #121319; color: #a9afd0; font: 12px ui-monospace, Menlo, monospace; }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 16px; }
  h2 { font-size: 12px; font-weight: 600; margin: 24px 0 8px; }
  h2 span { opacity: .6; font-weight: 400; }
  .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 4px; }
  figure { margin: 0; padding: 10px 4px 8px; display: flex; flex-direction: column; align-items: center; gap: 8px; border: 1px solid #1d1f29; border-radius: 6px; }
  .pair { display: flex; align-items: center; gap: 10px; }
  figcaption { font: 10px ui-monospace, Menlo, monospace; text-align: center; overflow-wrap: anywhere; }
</style></head>
<body><h1>SlicerX icons, ${Object.keys(ICON_PATHS).length} total</h1>
${sections}
</body></html>
`
writeFileSync(out, html)
console.log(`wrote ${out} with ${Object.keys(ICON_PATHS).length} icons`)
