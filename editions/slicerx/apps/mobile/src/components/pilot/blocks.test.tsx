// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { render, screen } from '@testing-library/react-native'
import { ChatImage, RASTER_DATA_URL } from './blocks'

it('draws a camera frame sent as a data URL, with its caption', async () => {
  await render(<ChatImage display={{ kind: 'image', src: 'data:image/jpeg;base64,QUJD', alt: 'Bay 1 camera', caption: 'Layer 12' }} />)
  expect(screen.getByRole('img', { name: 'Bay 1 camera' })).toBeOnTheScreen()
  expect(screen.getByText('Layer 12')).toBeOnTheScreen()
})

it('never loads a remote or SVG source', async () => {
  expect(RASTER_DATA_URL.test('https://example.com/a.jpg')).toBe(false)
  expect(RASTER_DATA_URL.test('data:image/svg+xml;base64,QUJD')).toBe(false)
  await render(<ChatImage display={{ kind: 'image', src: 'https://example.com/a.jpg', alt: 'Frame' }} />)
  expect(screen.queryByRole('img', { name: 'Frame' })).toBeNull()
  expect(screen.getByText('Frame')).toBeOnTheScreen()
})
