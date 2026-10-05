// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { EASY_GOALS } from '@slicerx/contracts'
import { FLEETS, MODEL_CHOICES, PRINTERS } from './fixtures'
import { SendPrintScreen, type SendPrintScreenProps } from './send-print-screen'


function props(over: Partial<SendPrintScreenProps> = {}): SendPrintScreenProps {
  return {
    library: MODEL_CHOICES,
    printers: PRINTERS,
    fleets: FLEETS,
    sliceLocation: { kind: 'desktop', name: 'Studio Mac', detail: 'Picked by pairing, online' },
    onSelectionChange: jest.fn(),
    estimate: null,
    estimating: false,
    onPickFile: jest.fn(() => Promise.resolve(null)),
    onSend: jest.fn(() => Promise.resolve()),
    onBack: jest.fn(),
    ...over,
  }
}


it('keeps Print off until a model and a printer are picked', async () => {
  await render(<SendPrintScreen {...props()} />)
  expect(screen.getByTestId('send-button')).toBeDisabled()
  await fireEvent.press(screen.getByTestId('model-choose'))
  await fireEvent.press(screen.getByTestId('pick-m2'))
  expect(screen.getByTestId('send-button')).toBeDisabled()
  await fireEvent.press(screen.getByTestId('target-bay-2'))
  expect(screen.getByTestId('send-button')).toBeEnabled()
})

it('only lets you pick printers that are ready', async () => {
  await render(<SendPrintScreen {...props()} />)
  expect(screen.getByTestId('target-bay-1')).toBeDisabled()
  expect(screen.getByTestId('target-bay-5')).toBeDisabled()
  expect(screen.getByTestId('target-fleet-workshop')).toBeEnabled()
})

it('reports the selection with Easy settings for the goal', async () => {
  const p = props({ initialModelId: 'm1', initialTarget: { kind: 'fleet', fleetId: 'workshop' } })
  await render(<SendPrintScreen {...p} />)
  await fireEvent.press(screen.getByTestId('goal-fine'))
  await fireEvent.press(screen.getByTestId('supports-off'))
  expect(p.onSelectionChange).toHaveBeenLastCalledWith({
    modelId: 'm1',
    target: { kind: 'fleet', fleetId: 'workshop' },
    goal: 'fine',
    settings: { ...EASY_GOALS.fine, supports: 'off' },
  })
})

it('sends after the confirm sheet', async () => {
  const p = props({ initialModelId: 'm1', initialTarget: { kind: 'printer', printerId: 'bay-2' }, estimate: { timeS: 6720, grams: 38.4, plates: 1 } })
  await render(<SendPrintScreen {...p} />)
  expect(screen.getByTestId('estimate')).toHaveTextContent('1h 52m  38.4 g')
  await fireEvent.press(screen.getByTestId('send-button'))
  expect(screen.getByText('Print Hex planter?')).toBeTruthy()
  expect(screen.getByText('Slices on Studio Mac with Standard settings')).toBeTruthy()
  await fireEvent.press(screen.getByTestId('send-sheet-confirm'))
  await waitFor(() => expect(p.onSend).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'm1', goal: 'standard' })))
})

it('cannot send when there is nowhere to slice', async () => {
  await render(<SendPrintScreen {...props({ sliceLocation: null, initialModelId: 'm1', initialTarget: { kind: 'printer', printerId: 'bay-2' } })} />)
  expect(screen.getByText('Nowhere to slice yet')).toBeTruthy()
  expect(screen.getByTestId('send-button')).toBeDisabled()
})

it('adds a model from files', async () => {
  const p = props({ onPickFile: jest.fn(() => Promise.resolve('m3')) })
  await render(<SendPrintScreen {...p} />)
  await fireEvent.press(screen.getByTestId('model-choose'))
  await fireEvent.press(screen.getByTestId('pick-file'))
  await screen.findByTestId('model-selected')
  expect(screen.getByText('Harbor lantern')).toBeTruthy()
})

it('prompts to sign in instead of failing when cloud slicing has no token', async () => {
  const onSignInForCloud = jest.fn()
  await render(<SendPrintScreen {...props({ sliceLocation: null, onSignInForCloud })} />)
  expect(screen.queryByText('Nowhere to slice yet')).toBeNull()
  await fireEvent.press(screen.getByTestId('slice-sign-in'))
  expect(onSignInForCloud).toHaveBeenCalled()
})
