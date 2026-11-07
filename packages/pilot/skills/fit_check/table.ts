// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The clearance table's place in knowledge/workflows/techniques/fits.yaml: the facts between two marker lines, written
// from the fit rule (clearance.ts) by scripts/fit-table.ts and checked against it by test/fit-table.test.ts.
import { clearanceFacts } from './clearance'

export const TABLE_START = '  # print-in-place clearance table, written by scripts/fit-table.ts from the fit rule; do not edit by hand'
export const TABLE_END = '  # end of the clearance table'
/** The source each fact of the table cites. */
export const TABLE_SOURCE = 'slicerx_fit_rule'

/** The table's lines as fits.yaml holds them, markers included. */
export function clearanceTableLines(): string[] {
  return [TABLE_START, ...clearanceFacts().map((t) => `  - {text: ${JSON.stringify(t)}, src: [${TABLE_SOURCE}]}`), TABLE_END]
}

/** The file's text with the table between its markers written again; a file without the markers is returned as it is. */
export function withClearanceTable(text: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(TABLE_START)
  const end = lines.indexOf(TABLE_END)
  if (start < 0 || end < start) return text
  return [...lines.slice(0, start), ...clearanceTableLines(), ...lines.slice(end + 1)].join('\n')
}
