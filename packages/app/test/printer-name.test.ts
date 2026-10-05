// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { printerName } from '../src/lib/printer-name'

describe('printerName', () => {
  const h2d = { name: 'H2D', vendor: 'Bambu Lab', model: 'H2D' }
  it('shows the name a printer announces when it was added under its model alone', () => {
    expect(printerName(h2d, { ownName: 'Tawain #1' })).toBe('Tawain #1')
    expect(printerName({ ...h2d, name: 'Bambu Lab H2D' }, { ownName: 'Tawain #1' })).toBe('Tawain #1')
    expect(printerName({ ...h2d, name: ' ' }, { ownName: 'Tawain #1' })).toBe('Tawain #1')
  })
  it('keeps a name the person typed, and the stored name when the printer has not been heard', () => {
    expect(printerName({ ...h2d, name: 'Garage' }, { ownName: 'Tawain #1' })).toBe('Garage')
    expect(printerName(h2d, {})).toBe('H2D')
    expect(printerName(h2d, null)).toBe('H2D')
    expect(printerName(h2d, { ownName: '  ' })).toBe('H2D')
  })
})
