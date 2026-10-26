// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The keys a project open adds because the app that wrote the file reads them differently when they are missing
// (engine-choices.json fromApp), and SlicerX's defaults for the keys any project leaves out (engine-choices.json
// defaults), against the shared cases in fixtures/project-defaults.json. sx-core, the MCP server and the app run the same
// cases.
import { describe, expect, it } from 'vitest'
import cases from '../fixtures/project-defaults.json'
import engineChoices from '../engine-choices.json'
import { SLICERX_DEFAULTS, appMissingKeys, projectDefaults } from './engine-choices'

describe('appMissingKeys', () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      expect(appMissingKeys(c.settings, 'application' in c ? c.application : undefined)).toEqual(c.added)
    })
  }

  it('reads the table from engine-choices.json, the file sx-core reads too', () => {
    const table = (engineChoices as { fromApp?: Record<string, Record<string, { value: unknown }>> }).fromApp
    expect(Object.keys(table ?? {})).toEqual(['BambuStudio'])
    expect(Object.fromEntries(Object.entries(table?.['BambuStudio'] ?? {}).map(([k, v]) => [k, v.value]))).toEqual(cases.cases[0]?.added)
  })

  it('leaves the settings it is given as they are', () => {
    const settings = { layer_height: '0.2' }
    appMissingKeys(settings, 'BambuStudio-02.08.02.61')
    expect(settings).toEqual({ layer_height: '0.2' })
  })
})

describe('projectDefaults', () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      expect(projectDefaults(c.settings)).toEqual(c.defaults)
    })
  }

  it('reads the defaults from engine-choices.json, for every app: 0.2 mm support gaps for a project without them', () => {
    expect(SLICERX_DEFAULTS).toEqual(cases.cases[0]?.defaults)
    expect(SLICERX_DEFAULTS).toMatchObject({ support_top_z_distance: 0.2, support_bottom_z_distance: 0.2 })
  })
})
