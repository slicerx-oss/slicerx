// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, expect, it } from 'vitest'
import { assistantBrand, setAssistantBrand, setAssistantName } from '@slicerx/contracts'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { currentEdition, NEUTRAL, setCurrentEdition } from '../src/edition'
import { STEP_TITLES } from '../src/first-run/model'
import { TIPS } from '../src/lib/tips'
import { PROVIDERS } from '../src/pilot-connect/keys'
import { runCall } from '../src/app-link/methods'

const original = currentEdition()
afterEach(() => { setCurrentEdition(original); setAssistantBrand() })

it('reads a Path B name set after imports in tips, setup and provider labels', () => {
  setAssistantName('YourMate')
  expect(ASSISTANT_NAME).toBe('YourMate')
  expect(STEP_TITLES.mimir).toBe('YourMate')
  expect(TIPS['mode.mimir']!.title).toBe('YourMate')
  expect(TIPS['pilot.ask']!.title).toBe('Ask YourMate')
  expect(TIPS['pilot.close']!.title).toBe('Close YourMate')
  expect(PROVIDERS['mimir-cloud'].label).toBe('YourMate cloud')
})

it('loads an edition once and reads back the effective identity after a name override', async () => {
  const edition = { ...NEUTRAL, brand: { ...NEUTRAL.brand, assistant: { name: 'yourmate', icon: 'helper.svg', accent: '#006b65' } } }
  setCurrentEdition(edition)
  expect(assistantBrand()).toEqual(edition.brand.assistant)
  setAssistantName('YourMate')
  setCurrentEdition(edition)
  expect(await runCall('app.info', {})).toMatchObject({ assistant: { name: 'YourMate', icon: 'helper.svg', accent: '#006b65', enabled: edition.features.pilot } })
})
