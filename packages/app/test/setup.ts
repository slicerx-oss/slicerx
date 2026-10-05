// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tests read the app's text as the SlicerX edition shows it. test/rebrand.test.ts runs a white-label one.
import { NEUTRAL, setCurrentEdition } from '../src/edition'

setCurrentEdition({ ...NEUTRAL, id: 'slicerx', brand: { ...NEUTRAL.brand, name: 'SlicerX', shortName: 'SlicerX' }, apps: { ...NEUTRAL.apps, deepLinkScheme: 'slicerx' } })
