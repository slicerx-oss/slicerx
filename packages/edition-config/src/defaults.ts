// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Neutral defaults: the base reference app with no edition features and no brand of ours.
import type { EditionConfigInput } from './schema.ts'

export const NEUTRAL_EDITION: EditionConfigInput = {
  schemaVersion: 1,
  id: 'reference',
  brand: {
    name: 'Reference Slicer',
    shortName: 'Slicer',
    logo: { mark: 'builtin:generic-mark' },
    theme: 'subban',
  },
  apps: {
    desktop: { identifier: 'org.example.slicer', productName: 'Reference Slicer' },
    deepLinkScheme: 'reference-slicer',
  },
  features: {
    store: false,
    feed: false,
    creators: false,
    cloudSlicing: false,
    phonePairing: false,
    pilot: true,
  },
  ai: { provider: 'openai', model: 'gpt-6-sol', keySource: 'keychain' },
}
