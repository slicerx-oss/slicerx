// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen } from '@testing-library/react-native'
import { TabBar, type TabItem } from './tab-bar'

const TABS: TabItem[] = [
  { key: 'printers', icon: 'printer', label: 'Printers', badge: true },
  { key: 'library', icon: 'library', label: 'Library' },
  { key: 'account', icon: 'settings', label: 'Account' },
]

it('marks the active tab and names a tab that needs you', async () => {
  await render(<TabBar tabs={TABS} active="library" onSelect={jest.fn()} />)
  expect(screen.getByRole('tab', { name: 'Library' })).toBeSelected()
  expect(screen.getByRole('tab', { name: 'Printers, needs you' })).not.toBeSelected()
  expect(screen.queryByRole('tab', { name: /mimir/ })).toBeNull()
})

it('selects another tab and reports a second tap on the active one', async () => {
  const onSelect = jest.fn()
  const onReselect = jest.fn()
  await render(<TabBar tabs={TABS} active="printers" onSelect={onSelect} onReselect={onReselect} />)
  await fireEvent.press(screen.getByTestId('tab-library'))
  expect(onSelect).toHaveBeenCalledWith('library')
  await fireEvent.press(screen.getByTestId('tab-printers'))
  expect(onReselect).toHaveBeenCalledWith('printers')
  expect(onSelect).toHaveBeenCalledTimes(1)
})
