// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { render, screen } from '@testing-library/react-native'
import { ICON_PATHS } from '@slicerx/ui/icons'
import { Icon, parseIcon } from './icon'

describe('parseIcon', () => {
  it('reads each shape and camel-cases its attributes', async () => {
    const shapes = parseIcon('<circle cx="12" cy="12" r="8.5" stroke-dasharray="2.2 2.4"/><path d="M3 21h18"/>')
    expect(shapes).toEqual([
      { tag: 'circle', props: { cx: '12', cy: '12', r: '8.5', strokeDasharray: '2.2 2.4' } },
      { tag: 'path', props: { d: 'M3 21h18' } },
    ])
  })

  it('parses every icon in the shared set to at least one shape', async () => {
    for (const [name, markup] of Object.entries(ICON_PATHS)) {
      expect({ name, n: parseIcon(markup).length > 0 }).toEqual({ name, n: true })
    }
  })
})

describe('Icon', () => {
  it('is hidden from screen readers without a label', async () => {
    await render(<Icon name="printer" />)
    expect(screen.queryByTestId('icon-printer')).toBeNull()
    expect(screen.getByTestId('icon-printer', { includeHiddenElements: true })).toBeOnTheScreen()
  })

  it('takes an accessible name when given one', async () => {
    await render(<Icon name="vault" label="Vault file" />)
    expect(screen.getByRole('img', { name: 'Vault file' })).toBeOnTheScreen()
  })
})
