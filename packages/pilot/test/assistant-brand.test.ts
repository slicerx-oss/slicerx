// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, expect, it } from 'vitest'
import { assistantBrand, assistantName, assistantText, onAssistantBrand, setAssistantBrand, setAssistantName } from '@slicerx/contracts'
import { systemPrompt } from '../src/prompt'
import { NO_GEOMETRY_NOTE, NO_MESH_NOTE, needsGeometry } from '../skills/geom_common/index'

afterEach(() => setAssistantBrand())

it('uses a name set after importing both prompt variants', () => {
  setAssistantName('yourmate')
  for (const scope of ['full', 'cad'] as const) expect(systemPrompt(scope)).toMatch(/^You are yourmate,/)
})

it('uses the current name in geometry skill refusals', () => {
  setAssistantName('yourmate')
  expect(NO_GEOMETRY_NOTE).toContain('yourmate cannot read')
  expect(NO_MESH_NOTE).toContain('yourmate no mesh data')
  expect(needsGeometry('Hollow').output).toEqual({ note: NO_GEOMETRY_NOTE })
  setAssistantName('mimir')
  expect(NO_GEOMETRY_NOTE).toContain('mimir cannot read')
})

it('brands display copy without renaming protocol identifiers or flags', () => {
  setAssistantName('YourMate')
  expect(assistantText("Ask mimir. Read mimir's answer; --mimir-cloud-status, mimir.status, builtin:mimir and slicerx_mimir stay stable.")).toBe("Ask YourMate. Read YourMate's answer; --mimir-cloud-status, mimir.status, builtin:mimir and slicerx_mimir stay stable.")
})

it('lets embedders change only the name and keeps the lowercase rule specific to mimir', () => {
  setAssistantBrand({ icon: 'helper.svg', accent: '#006b65' })
  setAssistantName('YourMate')
  expect(assistantBrand()).toEqual({ name: 'YourMate', icon: 'helper.svg', accent: '#006b65' })
  setAssistantName('MIMIR')
  expect(assistantName()).toBe('mimir')
  for (const name of ['', ' ', 'x\ny', 'x'.repeat(41)]) expect(() => setAssistantName(name)).toThrow()
})

it('shares the edition identity and restores the built-in default', () => {
  setAssistantBrand({ name: 'YourMate', icon: 'https://example.com/helper.svg', accent: '#006b65' })
  expect(assistantName()).toBe('YourMate')
  expect(assistantBrand()).toEqual({ name: 'YourMate', icon: 'https://example.com/helper.svg', accent: '#006b65' })
  setAssistantBrand()
  expect(assistantBrand()).toEqual({ name: 'mimir', icon: 'builtin:mimir' })
})

it('notifies only when the identity changes and supports unsubscribing', () => {
  setAssistantBrand()
  const seen: string[] = []
  const stop = onAssistantBrand(() => seen.push(assistantName()))
  setAssistantBrand({ name: 'yourmate' })
  setAssistantBrand({ name: 'yourmate' })
  stop()
  setAssistantBrand({ name: 'mimir' })
  expect(seen).toEqual(['yourmate'])
})
