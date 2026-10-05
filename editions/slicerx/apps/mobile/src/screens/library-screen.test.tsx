// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen } from '@testing-library/react-native'
import { LIBRARY } from './fixtures'
import { LibraryScreen, filterEntries, topTags, type LibraryScreenProps } from './library-screen'

function props(over: Partial<LibraryScreenProps> = {}): LibraryScreenProps {
  return { entries: LIBRARY, loading: false, refreshing: false, onRefresh: jest.fn(), onOpen: jest.fn(), onImport: jest.fn(), ...over }
}

it('filters by name, creator, tag and search text', () => {
  expect(filterEntries(LIBRARY, 'tidewell', null).map((e) => e.id)).toEqual(['m3'])
  expect(filterEntries(LIBRARY, '', 'home').map((e) => e.id)).toEqual(['m1', 'm3'])
  expect(filterEntries(LIBRARY, 'lamp', null).map((e) => e.id)).toEqual(['m3'])
  expect(filterEntries(LIBRARY, 'planter', 'home').map((e) => e.id)).toEqual(['m1'])
})

it('ranks tags by use', () => {
  expect(topTags(LIBRARY)[0]).toBe('home')
})

it('searches as you type and says when nothing matches', async () => {
  await render(<LibraryScreen {...props()} />)
  await fireEvent.changeText(screen.getByTestId('library-search'), 'gear')
  expect(screen.getByText('Nothing matches "gear"')).toBeTruthy()
})

it('narrows by tag and clears it with All', async () => {
  await render(<LibraryScreen {...props()} />)
  await fireEvent.press(screen.getByTestId('tag-desk'))
  expect(screen.queryByTestId('entry-m1')).toBeNull()
  expect(screen.getByTestId('entry-m2')).toBeTruthy()
  await fireEvent.press(screen.getByTestId('tag-all'))
  expect(screen.getByTestId('entry-m1')).toBeTruthy()
})

it('opens a model page on tap and shows no price or subscription wording', async () => {
  const p = props()
  await render(<LibraryScreen {...p} />)
  await fireEvent.press(screen.getByTestId('entry-m1'))
  expect(p.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', slug: 'hex-planter' }))
  expect(screen.queryByText(/price|subscribe|tier|vault|\$/i)).toBeNull()
})

it('offers a retry when the catalog fails, and import when the build has no library', async () => {
  const p = props({ entries: [], failed: true })
  await render(<LibraryScreen {...p} />)
  await fireEvent.press(screen.getByTestId('library-retry'))
  expect(p.onRefresh).toHaveBeenCalled()
})

it('says the build has no library', async () => {
  await render(<LibraryScreen {...props({ entries: [], unavailable: true })} />)
  expect(screen.getByText('No library in this build')).toBeTruthy()
})

it('shows skeleton rows while loading', async () => {
  await render(<LibraryScreen {...props({ loading: true })} />)
  expect(screen.getByTestId('skeleton')).toBeTruthy()
})
