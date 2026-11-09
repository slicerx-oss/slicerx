// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen } from '@testing-library/react-native'
import { ChatImage, RASTER_DATA_URL, ToolRow } from './blocks'

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

it('keeps an engine refusal\'s own words in the opened row only', async () => {
  const raw = 'radiusMm: 6 mm does not fit on this face; at most 5.000 mm'
  const shown = 'That size is too big for this part, so the step was not made. Try a smaller size.'
  const row = { callId: 'c1', tool: 'geom.fillet', source: 'command' as const, args: '', callSummary: undefined, state: 'bad' as const, summary: shown, detail: raw, display: [], progress: [], ms: 40, untrusted: false }
  await render(<ToolRow row={row} />)
  expect(screen.getByText(shown)).toBeOnTheScreen()
  expect(screen.queryByText(raw)).toBeNull()
  await fireEvent.press(screen.getByTestId('tool-c1'))
  expect(screen.getByTestId('tool-c1-engine')).toHaveTextContent(raw)
})
