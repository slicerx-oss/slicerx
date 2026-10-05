// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { FLEETS, NOW, PRINTERS } from './fixtures'
import { PrintersScreen, summarize, type PrintersScreenProps } from './printers-screen'

function props(over: Partial<PrintersScreenProps> = {}): PrintersScreenProps {
  return {
    printers: PRINTERS,
    fleets: FLEETS,
    loading: false,
    refreshing: false,
    onRefresh: jest.fn(),
    onOpenPrinter: jest.fn(),
    onOpenNotifications: jest.fn(),
    unreadNotifications: 0,
    onAddPrinter: jest.fn(),
    ...over,
  }
}

it('summarizes the fleet in one line', async () => {
  expect(summarize(PRINTERS)).toBe('1 printing, 1 idle, 1 needs you, 1 offline')
})

it('puts the printer that needs you first and offline last', async () => {
  await render(<PrintersScreen {...props()} />)
  const ids = screen.getAllByTestId(/^printer-bay-/).map((n) => n.props.testID)
  expect(ids).toEqual(['printer-bay-3', 'printer-bay-1', 'printer-bay-2', 'printer-bay-5'])
})

it('shows the camera, state, time left and temperatures on a printing tile', async () => {
  await render(<PrintersScreen {...props({ now: NOW })} />)
  const tile = within(screen.getByTestId('printer-bay-1'))
  expect(tile.getByTestId('live-view')).toBeTruthy()
  expect(tile.getByText('Printing 62%')).toBeTruthy()
  expect(tile.getByText('1h 24m left')).toBeTruthy()
  expect(tile.getByText('62%')).toBeTruthy()
  expect(tile.getByText('Done by 15:29')).toBeTruthy()
  expect(tile.getByText('250 / 250 °C')).toBeTruthy()
  expect(tile.getByRole('progressbar', { name: 'Tidewell harbor lantern.gcode.3mf progress' })).toBeTruthy()
})

it('folds an offline printer into a plain row and badges a waiting approval', async () => {
  await render(<PrintersScreen {...props({ approvals: { 'bay-3': 1 } })} />)
  expect(within(screen.getByTestId('printer-bay-5')).queryByTestId('live-view')).toBeNull()
  expect(within(screen.getByTestId('printer-bay-3')).getByText('Approval waiting')).toBeTruthy()
  expect(within(screen.getByTestId('printer-bay-3')).getByText('No camera on this printer')).toBeTruthy()
})

it('filters by fleet and back to all', async () => {
  await render(<PrintersScreen {...props()} />)
  await fireEvent.press(screen.getByTestId('fleet-workshop'))
  expect(screen.queryByTestId('printer-bay-5')).toBeNull()
  await fireEvent.press(screen.getByTestId('fleet-all'))
  expect(screen.getByTestId('printer-bay-5')).toBeTruthy()
})

it('opens a printer', async () => {
  const p = props()
  await render(<PrintersScreen {...p} />)
  await fireEvent.press(screen.getByTestId('printer-bay-2'))
  expect(p.onOpenPrinter).toHaveBeenCalledWith('bay-2')
})

it('shows skeleton rows while loading and a pairing prompt when empty', async () => {
  const { rerender } = await render(<PrintersScreen {...props({ loading: true })} />)
  expect(screen.getByTestId('skeleton')).toBeTruthy()
  await rerender(<PrintersScreen {...props({ printers: [], fleets: [] })} />)
  expect(screen.getByText('Pair a computer')).toBeTruthy()
})
