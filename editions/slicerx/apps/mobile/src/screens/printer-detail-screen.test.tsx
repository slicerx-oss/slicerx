// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { FeedView } from '../camera/use-feed'
import { NOW, PRINTERS, RUN_EVENTS } from './fixtures'
import { pilotPrompt, PrinterDetailScreen, type PrinterDetailScreenProps } from './printer-detail-screen'

const printing = PRINTERS[0]!
const paused = PRINTERS[2]!
const idle = PRINTERS[1]!

const FEED: FeedView = { frame: { uri: 'file:///frame.jpg', at: NOW }, mode: 'live', stats: { fps: 12, kbps: 900, quality: 'high' }, loading: false, stale: false, unavailable: false }

function props(over: Partial<PrinterDetailScreenProps> = {}): PrinterDetailScreenProps {
  return {
    printer: printing,
    feed: FEED,
    refreshing: false,
    onRefresh: jest.fn(),
    onControl: jest.fn(() => Promise.resolve()),
    onSendPrint: jest.fn(),
    onAskPilot: jest.fn(),
    onBack: jest.fn(),
    now: NOW,
    ...over,
  }
}

it('shows live video, progress and the finish time', async () => {
  await render(<PrinterDetailScreen {...props()} />)
  expect(screen.getByRole('img', { name: 'Bay 1 camera' })).toBeOnTheScreen()
  expect(screen.getByText('Live, 12 fps')).toBeOnTheScreen()
  expect(screen.getByText('62%')).toBeOnTheScreen()
  expect(screen.getByText('Layer 148 of 238')).toBeOnTheScreen()
  expect(screen.getByText('Done by 15:29')).toBeOnTheScreen()
  expect(screen.getByText('250 °C')).toBeOnTheScreen()
})

it('pauses with one tap', async () => {
  const p = props()
  await render(<PrinterDetailScreen {...p} />)
  await fireEvent.press(screen.getByTestId('control-pause'))
  await waitFor(() => expect(p.onControl).toHaveBeenCalledWith('pause'))
})

it('stops only after the sheet is confirmed', async () => {
  const p = props()
  await render(<PrinterDetailScreen {...p} />)
  await fireEvent.press(screen.getByTestId('control-stop'))
  expect(screen.getByText('Stop the print on Bay 1?')).toBeTruthy()
  expect(screen.getByText('Stops Tidewell harbor lantern.gcode.3mf at 62%')).toBeTruthy()
  expect(p.onControl).not.toHaveBeenCalled()
  await fireEvent.press(screen.getByTestId('control-sheet-confirm'))
  await waitFor(() => expect(p.onControl).toHaveBeenCalledWith('stop'))
})

it('shows why a control did not go through', async () => {
  const p = props({ onControl: jest.fn(() => Promise.reject(new Error('The computer is offline'))) })
  await render(<PrinterDetailScreen {...p} />)
  await fireEvent.press(screen.getByTestId('control-pause'))
  expect(await screen.findByText('The computer is offline')).toBeOnTheScreen()
})

it('offers resume and mimir on a paused printer, send on an idle one', async () => {
  const p = props({ printer: paused, feed: { ...FEED, frame: null, mode: null, stats: null } })
  const { rerender } = await render(<PrinterDetailScreen {...p} />)
  expect(screen.getByTestId('control-resume')).toBeTruthy()
  expect(screen.queryByTestId('control-pause')).toBeNull()
  expect(screen.getByText('No camera on this printer')).toBeTruthy()
  await fireEvent.press(screen.getByTestId('ask-pilot'))
  expect(p.onAskPilot).toHaveBeenCalledWith('Why did Bay 3 pause (Filament change requested), and what should I check before resuming?')
  await rerender(<PrinterDetailScreen {...props({ printer: idle })} />)
  expect(screen.queryByTestId('control-stop')).toBeNull()
  expect(screen.getByText('Ready for a print')).toBeOnTheScreen()
  await fireEvent.press(screen.getByTestId('control-send'))
})

it('answers an approval waiting on this printer with a tap', async () => {
  const request = RUN_EVENTS.find((e) => e.type === 'approval_request')!.request
  const decide = jest.fn(() => Promise.resolve())
  await render(<PrinterDetailScreen {...props({ printer: idle, approvals: [{ id: request.id, request: { ...request, expiresAt: new Date(Date.now() + 300_000).toISOString() }, heading: 'mimir on Studio Mac needs your approval', decide }], now: NOW })} />)
  expect(screen.getByText('Send 1 plate to Bay 2?')).toBeOnTheScreen()
  await fireEvent.press(screen.getByTestId('approval-approve'))
  await waitFor(() => expect(decide).toHaveBeenCalledWith('approve', { bedClear: false }))
})

it('marks a feed that stopped sending frames', async () => {
  await render(<PrinterDetailScreen {...props({ feed: { ...FEED, stale: true } })} />)
  expect(screen.getByText('No picture')).toBeOnTheScreen()
})

it('asks a question that fits the printer state', async () => {
  expect(pilotPrompt(PRINTERS[3]!)).toBe('Bay 5 is offline. How do I get it back?')
  expect(pilotPrompt(idle)).toBe('How is Bay 2 doing?')
})
