// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The result of a preset import and its one line summary. Kept apart from import-files.ts so the setup screen can
// show results without loading the importer, which carries the settings schema and the profile data.
import type { ImportReport } from '@slicerx/settings'
import type { PresetKind } from './store'

/** File types the import takes. */
export const PRESET_FILE_TYPES: readonly string[] = ['.json', '.ini', '.orca_printer', '.orca_filament', '.orca_bundle', '.bbscfg', '.bbsflmt', '.zip']

export interface ImportResult {
  /** The preset's name as saved, or the file's name when it could not be imported. */
  name: string
  ok: boolean
  kind?: PresetKind
  /** Settings that did not carry over. */
  skipped: number
  report?: ImportReport
  message?: string
}

/** One line for a finished import: "3 presets imported, 12 settings did not carry over". */
export function importSummary(results: readonly ImportResult[]): string {
  const ok = results.filter((r) => r.ok)
  const failed = results.length - ok.length
  const skipped = ok.reduce((n, r) => n + r.skipped, 0)
  const parts: string[] = []
  parts.push(ok.length === 0 ? 'Nothing imported' : ok.length === 1 ? '1 preset imported' : `${ok.length} presets imported`)
  if (skipped) parts.push(`${skipped} ${skipped === 1 ? 'setting' : 'settings'} did not carry over`)
  if (failed) parts.push(`${failed} ${failed === 1 ? 'file' : 'files'} skipped`)
  return parts.join(', ')
}
