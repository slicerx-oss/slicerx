// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tests read the app's text as the SlicerX edition shows it. test/rebrand.test.ts runs a white-label one.
import { configure } from '@testing-library/react'
import { NEUTRAL, setCurrentEdition } from '../src/edition'

setCurrentEdition({ ...NEUTRAL, id: 'slicerx', brand: { ...NEUTRAL.brand, name: 'SlicerX', shortName: 'SlicerX' }, apps: { ...NEUTRAL.apps, deepLinkScheme: 'slicerx' } })

// findBy* and waitFor give up after 1 s by default. A sheet over the offline store shows only after the bundled seed and
// a few queries in turn have loaded, which on a loaded machine took up to 14 s, so they wait as long as 20 s: well inside
// the 60 s test limit in vitest.config.ts, with room for a second wait in the same test.
configure({ asyncUtilTimeout: 20_000 })
