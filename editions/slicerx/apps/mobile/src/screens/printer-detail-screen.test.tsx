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

// A Bambu Lab printer names the step its job is on as the stage: shown with the job, as the desktop shows it, and
// not as the orange problem line.
it('shows the job stage with the job, not as a problem', async () => {
  const preparing = { ...printing, status: { ...printing.status!, state: 'preparing' as const, layer: 0, live: { stage: 'Calibrating flow dynamics' } } }
  await render(<PrinterDetailScreen {...props({ printer: preparing })} />)
  expect(screen.getByTestId('printer-job-stage')).toHaveTextContent('Calibrating flow dynamics')
  expect(screen.queryByTestId('printer-message')).toBeNull()
})

// What the printer says about itself: the firmware it runs, and each filament unit's humidity, temperature and drying.
it('shows the firmware and each filament unit\'s humidity and drying', async () => {
  const live = { units: [{ id: 'A', kind: 'ams-2-pro' as const, climate: { humidityPct: 22, tempC: 26 } }, { id: 'B', kind: 'ams-ht' as const, climate: { humidityPct: 11, tempC: 45, drying: true, dryMinutesLeft: 200 } }] }
  const slots = [{ id: 'A1', material: 'PLA' }, { id: 'B1', material: 'PETG' }]
  const h2d = { ...idle, status: { ...idle.status!, firmware: '01.04.00.00', slots, live } }
  await render(<PrinterDetailScreen {...props({ printer: h2d })} />)
  expect(screen.getByTestId('printer-firmware')).toHaveTextContent('Firmware 01.04.00.00')
  expect(screen.getByTestId('unit-climate-A')).toHaveTextContent('AMS 2 Pro: 22% humidity · 26 °C')
  expect(screen.getByTestId('unit-climate-B')).toHaveTextContent('AMS HT: 11% humidity · 45 °C · Drying, 3 h 20 min left')
})

it('leaves the firmware and unit lines out when the printer does not report them', async () => {
  await render(<PrinterDetailScreen {...props({ printer: idle })} />)
  expect(screen.queryByTestId('printer-firmware')).toBeNull()
  expect(screen.queryByTestId(/^unit-climate-/)).toBeNull()
})
