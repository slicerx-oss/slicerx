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

// A refused plan step and a normal step. Neutral content: a box. The phone has no developer setting, so an opened row
// never shows the command line or a refusal's raw text.
const KEY_PATTERN = /\b[a-z_]+: /
const RAW = 'A display model plan was not shown. tiers: Box is not a planned feature'
const SHOWN = 'That step could not be made, so the part is unchanged. Try asking for it another way.'
const refused = { callId: 'r1', tool: 'design.plan', source: 'command' as const, args: '--tiers "box" --features 3', callSummary: undefined, state: 'bad' as const, title: 'Step not made', summary: SHOWN, detail: RAW, display: [], progress: [], ms: 40, untrusted: false }
const normal = { callId: 'n1', tool: 'design.put_plan', source: 'command' as const, args: '--name box --size "20 x 20 x 10"', callSummary: undefined, state: 'ok' as const, summary: 'Box planned', display: [{ kind: 'kv' as const, rows: [['Size', '20 x 20 x 10 mm']] as [string, string][] }], progress: [], ms: 60, untrusted: false }

const textOf = (node: unknown): string => {
  const n = node as { children?: unknown[] } | string | null
  if (n === null || n === undefined) return ''
  if (typeof n === 'string') return n
  return (n.children ?? []).map(textOf).join('')
}

it('keeps a refused step\'s raw words and command line out of the row, opened or not', async () => {
  await render(<ToolRow row={refused} />)
  expect(screen.getByText(SHOWN)).toBeOnTheScreen()
  expect(screen.queryByText(RAW)).toBeNull()
  // nothing person-facing to open to, so the row is a plain line: no expander, no details
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByTestId('tool-r1-detail')).toBeNull()
  expect(screen.queryByTestId('tool-r1-engine')).toBeNull()
  expect(screen.queryByText(/\$ /)).toBeNull()
  expect(screen.queryByText(/tiers/)).toBeNull()
})

it('opens a normal step to its output only, with no key, tool name or command line', async () => {
  await render(<ToolRow row={normal} />)
  expect(screen.queryByTestId('tool-n1-detail')).toBeNull()
  await fireEvent.press(screen.getByTestId('tool-n1'))
  const detail = textOf(screen.getByTestId('tool-n1-detail'))
  expect(detail).toContain('20 x 20 x 10 mm')
  expect(detail).not.toMatch(KEY_PATTERN)
  expect(detail).not.toMatch(/design[._]+put_plan/)
  expect(detail).not.toContain('$ ')
  expect(detail).not.toContain('--')
  expect(screen.queryByTestId('tool-n1-engine')).toBeNull()
})

it('keeps the outside-data note when a refused step is also untrusted', async () => {
  await render(<ToolRow row={{ ...refused, callId: 'u1', untrusted: true }} />)
  await fireEvent.press(screen.getByTestId('tool-u1'))
  const detail = textOf(screen.getByTestId('tool-u1-detail'))
  expect(detail).toContain('mimir reads it as data')
  expect(detail).not.toContain('tiers')
  expect(detail).not.toContain('$ ')
})
