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

it('says to open a picked STEP file on desktop or web, and keeps the sheet open', async () => {
  const message = "STEP and IGES files can't be opened on the phone. Open this file on desktop or web."
  const p = props({ onPickFile: jest.fn(() => Promise.reject(new Error(message))) })
  await render(<SendPrintScreen {...p} />)
  await fireEvent.press(screen.getByTestId('model-choose'))
  await fireEvent.press(screen.getByTestId('pick-file'))
  expect(await screen.findByText(message)).toBeTruthy()
  expect(screen.getByTestId('pick-file')).toBeTruthy()
})

it('prompts to sign in instead of failing when cloud slicing has no token', async () => {
  const onSignInForCloud = jest.fn()
  await render(<SendPrintScreen {...props({ sliceLocation: null, onSignInForCloud })} />)
  expect(screen.queryByText('Nowhere to slice yet')).toBeNull()
  await fireEvent.press(screen.getByTestId('slice-sign-in'))
  expect(onSignInForCloud).toHaveBeenCalled()
})

it('puts a card on top and holds Print back while the model does not fit the printer', async () => {
  const fit = { fits: false, bed: [256, 256, 256] as [number, number, number], size: [300, 200, 5] as [number, number, number], footprint: { min: [-22, 28] as [number, number], max: [278, 228] as [number, number] }, over: [44, 0, 0] as [number, number, number] }
  await render(<SendPrintScreen {...props({ initialModelId: 'm1', initialTarget: { kind: 'printer', printerId: 'bay-2' }, fit })} />)
  expect(screen.getByTestId('fit-card')).toBeTruthy()
  expect(screen.getByTestId('send-button')).toBeDisabled()
  expect(screen.getByText('Does not fit this printer')).toBeTruthy()
})

it('shows no card when the model fits', async () => {
  const fit = { fits: true, bed: [256, 256, 256] as [number, number, number], size: [20, 20, 20] as [number, number, number], footprint: { min: [118, 118] as [number, number], max: [138, 138] as [number, number] }, over: [0, 0, 0] as [number, number, number] }
  await render(<SendPrintScreen {...props({ initialModelId: 'm1', initialTarget: { kind: 'printer', printerId: 'bay-2' }, fit })} />)
  expect(screen.queryByTestId('fit-card')).toBeNull()
  expect(screen.getByTestId('send-button')).toBeEnabled()
})

describe('a 3MF project with several plates', () => {
  const plates = [
    { plate: 1, name: 'Base', objects: 3 },
    { plate: 2, name: '', objects: 1 },
    { plate: 4, name: 'Lid', objects: 2 },
  ]

  it('asks which plate, starts on the first, and sends only the one picked', async () => {
    const p = props({ initialModelId: 'm1', initialTarget: { kind: 'printer', printerId: 'bay-2' }, plates })
    await render(<SendPrintScreen {...p} />)
    expect(screen.getByText('Plate 1: Base')).toBeTruthy()
    expect(screen.getByText('Plate 2')).toBeTruthy()
    expect(screen.getByText('2 objects')).toBeTruthy()
    expect(screen.getByTestId('plate-1')).toBeChecked()
    expect(p.onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ modelId: 'm1', plate: 1 }))
    await fireEvent.press(screen.getByTestId('plate-4'))
    expect(screen.getByTestId('plate-4')).toBeChecked()
    expect(screen.getByTestId('plate-1')).not.toBeChecked()
    expect(p.onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ plate: 4 }))
    await fireEvent.press(screen.getByTestId('send-button'))
    expect(screen.getByText('Print Hex planter, plate 4?')).toBeTruthy()
    expect(screen.getByText("Plate 4: Lid, 2 objects. The project's other plates are not sliced.")).toBeTruthy()
    await fireEvent.press(screen.getByTestId('send-sheet-confirm'))
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'm1', plate: 4 })))
  })

  it('shows no plate choice for a project with one plate', async () => {
    const p = props({ initialModelId: 'm1', initialTarget: { kind: 'printer', printerId: 'bay-2' }, plates: [plates[0]!] })
    await render(<SendPrintScreen {...p} />)
    expect(screen.queryByTestId('plate-1')).toBeNull()
    expect(p.onSelectionChange).toHaveBeenLastCalledWith(expect.not.objectContaining({ plate: expect.anything() }))
  })

  it('tells the parent which model is chosen, so it can read the plates', async () => {
    const onModelChange = jest.fn()
    await render(<SendPrintScreen {...props({ onModelChange })} />)
    await fireEvent.press(screen.getByTestId('model-choose'))
    await fireEvent.press(screen.getByTestId('pick-m2'))
    expect(onModelChange).toHaveBeenLastCalledWith('m2')
  })
})

it('shows the collision the slice stopped on, says so beside Print, and asks to print anyway', async () => {
  const hit = { kind: 'hotend', severity: 'hit', part: 'toolhead', objectId: 'b', hitId: 'a', damagedId: 'a', layer: 3, segment: 0, timeS: 9, lastLayer: 4, at: [0, 0, 1], point: [0, 0, 1], worstLayer: 3, worstPoint: [0, 0, 1], depthMm: 2, hitHeightMm: 10 } as const
  const plate = { bed: [[0, 0], [256, 0], [256, 256], [0, 256]] as [number, number][], objects: [{ id: 'a', name: 'Bracket', hull: [[0, 0], [10, 0], [10, 10]] as [number, number][] }, { id: 'b', name: 'Hook', hull: [[20, 0], [30, 0], [30, 10]] as [number, number][] }], zones: [] }
  const p = props({ initialModelId: 'm1', initialTarget: { kind: 'printer', printerId: 'bay-2' }, collision: { collisions: [hit as never], plate } })
  await render(<SendPrintScreen {...p} />)
  expect(screen.getByTestId('collision-card')).toBeTruthy()
  expect(screen.getByText('The toolhead hits Bracket')).toBeTruthy()
  expect(screen.getByTestId('collision-footer')).toHaveTextContent('1 collision on this plate')
  expect(screen.getByTestId('send-button')).toBeEnabled()
  await fireEvent.press(screen.getByTestId('send-button'))
  expect(screen.getByText('Print anyway')).toBeTruthy()
  expect(screen.getByText('The slice found 1 collision on this plate. Print anyway sends the file it made, as it is')).toBeTruthy()
  await fireEvent.press(screen.getByTestId('send-sheet-confirm'))
  await waitFor(() => expect(p.onSend).toHaveBeenCalledTimes(1))
})

it('shows no collision card without a stop', async () => {
  await render(<SendPrintScreen {...props({ initialModelId: 'm1', initialTarget: { kind: 'printer', printerId: 'bay-2' }, collision: null })} />)
  expect(screen.queryByTestId('collision-card')).toBeNull()
  expect(screen.queryByTestId('collision-footer')).toBeNull()
})
