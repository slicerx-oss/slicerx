// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes the 16 px tool icons to icons/tool/snapped16.json. They are drawn as whole-pixel grids already (draw.mjs), so
// this only freezes their markup for gen-tool-icons.mjs. Run it after changing a 16 px drawing, then gen-tool-icons.mjs.
// Run: node packages/ui/scripts/snap-tool-icons.mjs
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tool = resolve(here, '../icons/tool')
const { ICONS } = await import(pathToFileURL(resolve(tool, 'draw.mjs')).href)
const out = Object.fromEntries(Object.keys(ICONS).map((k) => [k, ICONS[k](16)]))
writeFileSync(resolve(tool, 'snapped16.json'), JSON.stringify(out, null, 1) + '\n')
console.log(`${Object.keys(out).length} icons at 16 px`)
