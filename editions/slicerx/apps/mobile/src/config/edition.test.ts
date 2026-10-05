// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { repairWebEdition } from './edition'

jest.mock('expo-constants', () => ({ expoConfig: {} }))

it('turns the {} that the web manifest leaves for backend strings into unset endpoints', () => {
  const fixed = repairWebEdition({ id: 'x', backend: { supabase: { url: {}, anonKey: {} }, cloudApi: {}, relay: {}, linkPort: 47615 } }) as { backend: Record<string, unknown> }
  expect(fixed.backend).toEqual({ supabase: null, cloudApi: null, relay: null, linkPort: 47615 })
})

it('leaves a real backend alone', () => {
  const edition = { backend: { supabase: { url: 'https://a.example', anonKey: 'k'.repeat(30) }, cloudApi: 'https://c.example', relay: null } }
  expect(repairWebEdition(edition)).toEqual(edition)
})
