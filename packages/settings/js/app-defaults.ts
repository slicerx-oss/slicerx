// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app that wrote a project file reads some keys its project lacks its own way (engine-choices.json fromApp). Its own
// module, with nothing but the table, so the app's project open can read it without loading the settings package.
import engineChoicesJson from '../engine-choices.json'

const FROM_APP = (engineChoicesJson as { fromApp?: Record<string, Record<string, { value: unknown; unlessAny?: string[]; sameAs?: string; note?: string }>> }).fromApp ?? {}

/**
 * The keys `settings` lacks that `application`, the app that wrote the project (the model's `Application` metadata,
 * `BambuStudio-02.08.02.61`), reads its own way, with the value it reads each as (engine-choices.json `fromApp`): a
 * Bambu Studio project without them gets the rib tower, 500 mm/s2 first layer travel and internal bridges at the bridge
 * speed. None for a key the settings have, or when they have a key the row's `unlessAny` names; none for another app.
 * A row with `sameAs` applies whatever the settings hold: that key's value, else the row's (a Bambu Studio project's
 * solid infill direction is its infill direction).
 * sx-core's project import (`sx slice <project.3mf>`) reads the same table.
 */
export function appMissingKeys(settings: Record<string, unknown>, application: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!application) return out
  for (const [app, rows] of Object.entries(FROM_APP)) {
    if (!application.startsWith(app)) continue
    for (const [k, row] of Object.entries(rows)) {
      if (row.sameAs) {
        out[k] = structuredClone(row.sameAs in settings ? settings[row.sameAs] : row.value)
        continue
      }
      if (k in settings || (row.unlessAny ?? []).some((u) => u in settings)) continue
      out[k] = structuredClone(row.value)
    }
  }
  return out
}

/**
 * The maker's app's reading of the keys its project lacks (engine-choices.json `fromApp`, through `appMissingKeys` in
 * @slicerx/settings): a Bambu Studio project without them gets the rib tower, 500 mm/s2 first layer travel and internal
 * bridges at the bridge speed. The same table as the engine's project import (`sx slice <project.3mf>`) and the MCP
 * server's project read: the app is the model's `Application` metadata. A project that has a key keeps its value, and
 * projects from other apps are unchanged.
 */
export function withBambuMissingKeys(settings: Record<string, unknown>, application: string | undefined): Record<string, unknown> {
  const added = appMissingKeys(settings, application)
  const missing = Object.keys(added)
  if (missing.length === 0) return settings
  const out: Record<string, unknown> = { ...settings, ...added }
  // A project that lists what it changed from its presets (and a nozzle the app has no profile for) applies only those:
  // these count as changed, as the maker's own reading of a missing key is not the preset's.
  const changed = settings['different_settings_to_system']
  if (Array.isArray(changed) && typeof changed[0] === 'string') out['different_settings_to_system'] = [`${changed[0].replace(/;\s*$/, '')}${changed[0].trim() ? ';' : ''}${missing.join(';')}`, ...changed.slice(1)]
  return out
}
