// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes the print-in-place clearance table into knowledge/workflows/techniques/fits.yaml from the fit rule
// (skills/fit_check/clearance.ts), between its two marker lines, so the table and the rule never disagree. Run
// kb:build after it. test/fit-table.test.ts fails when the file and the rule differ.
//
//   pnpm --filter @slicerx/pilot fit:table
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withClearanceTable } from '../skills/fit_check/table'

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'knowledge', 'workflows', 'techniques', 'fits.yaml')
const before = readFileSync(file, 'utf8')
const after = withClearanceTable(before)
if (after !== before) writeFileSync(file, after)
console.log(after !== before ? `wrote ${file}` : `${file} is up to date`)
