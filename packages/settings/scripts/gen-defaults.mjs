// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes defaults.json: every setting's section and default value, nothing else. It is the small part of
// schema.json that a startup path needs to build a config (labels, ranges, tiers and help are not in it),
// and js/defaults.test.ts fails when it is out of date. A setting with no default (one the engine works out when
// nothing sets it) is left out, so a default config never sets it. Run: node scripts/gen-defaults.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const schema = JSON.parse(readFileSync(new URL('../schema.json', import.meta.url), 'utf8'))
const out = {}
for (const d of schema.settings) if (d.default !== undefined) out[d.key] = [d.section, d.default]
writeFileSync(new URL('../defaults.json', import.meta.url), JSON.stringify(out) + '\n')
console.log(`defaults.json: ${Object.keys(out).length} settings`)
