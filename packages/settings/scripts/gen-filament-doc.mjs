// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes docs/filament-presets.md: what the filament presets cover and which profile versions they were checked against.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const idx = JSON.parse(readFileSync(here('../../profiles/filaments/index.json'), 'utf8'))
const byVendor = new Map()
for (const f of idx.families) {
  const v = byVendor.get(f.vendor) ?? { families: 0, presets: 0, brands: new Set() }
  v.families++; v.presets += f.variants.length; v.brands.add(f.brand)
  byVendor.set(f.vendor, v)
}
const brands = new Map()
for (const f of idx.families) { const b = brands.get(f.brand) ?? { families: 0, presets: 0, types: new Set() }; b.families++; b.presets += f.variants.length; b.types.add(f.type); brands.set(f.brand, b) }
const rows = [...byVendor].map(([v, x]) => `| ${v} | ${x.families} | ${x.presets} | ${[...x.brands].sort().join(', ')} |`)
const brandRows = [...brands].sort((a, b) => b[1].presets - a[1].presets).map(([b, x]) => `| ${b} | ${x.families} | ${x.presets} | ${[...x.types].sort().join(', ')} |`)
const fallbackCount = new Map()
const onlyFallback = []
for (const v of byVendor.keys()) {
  const f = JSON.parse(readFileSync(here(`../../profiles/filaments/${v}.json`), 'utf8'))
  for (const [name] of Object.entries(f.fallback ?? {})) fallbackCount.set(v, (fallbackCount.get(v) ?? 0) + 1)
}
const brandTotals = new Map()
for (const f of idx.families) {
  const file = JSON.parse(readFileSync(here(`../../profiles/filaments/${f.vendor}.json`), 'utf8'))
  const t = brandTotals.get(f.brand) ?? { all: 0, fb: 0 }
  for (const v of f.variants) { t.all++; if (file.fallback?.[v ? `${f.family} @${v}` : f.family]) t.fb++ }
  brandTotals.set(f.brand, t)
}
for (const [b, t] of brandTotals) if (t.all === t.fb) onlyFallback.push(b)
const fb = [...fallbackCount.values()].reduce((a, b) => a + b, 0)
const text = `# Filament presets

${idx.presets} presets in ${idx.families.length} products, with the resolved values of OrcaSlicer 2.4.2's filament profiles (commit ${idx.orcaCommit}). ${fb} presets are not in 2.4.2 and keep their values from OrcaSlicer main (commit ${idx.orcaMainCommit}) or, for Bambu Lab, Bambu Studio (commit ${idx.bambuStudioCommit}); each vendor file lists them under \`fallback\`, and \`loadFilamentPreset\` reports the source. Brands 2.4.2 has no preset for at all: ${onlyFallback.sort().join(', ') || 'none'}. Each preset carries every filament setting the profile sets: nozzle temperatures (first layer, other layers, range), bed temperatures per plate, chamber temperature, fan minimum and maximum, cooling thresholds and slowdown, overhang and bridge fan, flow ratio, pressure advance, maximum volumetric speed, retraction overrides, shrinkage, density, diameter, cost, the soluble and support flags, the filament start and end G-code, and the compatible printers.

The files are in \`packages/profiles/filaments/\`, one per vendor folder, plus \`index.json\`. A vendor file holds the vendor's common values, each product's own values and each printer variant's differences. \`loadFilamentPreset(vendor, family, variant)\` merges them and types the values; keys only some slicers define come back in \`extras\` in the profile's own format. \`js/filaments.test.ts\` locks the files, and a private script diffs them against the 2.4.2 profiles (and the fallback sources) and fails on any difference.

The Bambu Lab material id (\`filament_id\`) is Bambu Studio's, since 2.4.2 sets none.

Every filament setting is advanced in the schema, except the material (\`filament_type\`), the brand (\`filament_vendor\`) and the color (\`default_filament_colour\`).

## By vendor folder

| Vendor folder | Products | Presets | Brands |
| --- | --- | --- | --- |
${rows.join('\n')}

## By brand

| Brand | Products | Presets | Materials |
| --- | --- | --- | --- |
${brandRows.join('\n')}
`
writeFileSync(here('../docs/filament-presets.md'), text)
console.log(rows.length, 'vendors', brandRows.length, 'brands')
