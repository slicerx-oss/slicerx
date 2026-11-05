// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { ChoiceCard } from './choice-card'

const choices = [
  { id: 'same', label: 'Yes, that one' },
  { id: 'other', label: 'A different model' },
]

async function setup(overrides: Partial<Parameters<typeof ChoiceCard>[0]> = {}) {
  const onAnswer = jest.fn(() => Promise.resolve())
  await render(<ChoiceCard title="Confirm the part" question="Is this the thermostat on your wall?" choices={choices} heading="mimir on Studio Mac asks" caption="Your answer goes to mimir on Studio Mac." onAnswer={onAnswer} {...overrides} />)
  return { onAnswer }
}

it('live: the question, a button per choice, Cancel and where the answer goes', async () => {
  await setup()
  expect(screen.getByText('mimir on Studio Mac asks')).toBeTruthy()
  expect(screen.getByText('Confirm the part')).toBeTruthy()
  expect(screen.getByText('Is this the thermostat on your wall?')).toBeTruthy()
  expect(screen.getByTestId('choice-card-choice-same')).toBeTruthy()
  expect(screen.getByTestId('choice-card-choice-other')).toBeTruthy()
  expect(screen.getByTestId('choice-card-cancel')).toBeTruthy()
  expect(screen.getByText('Your answer goes to mimir on Studio Mac.')).toBeTruthy()
})

it('a tap answers with that choice, and Cancel with none', async () => {
  const { onAnswer } = await setup()
  await fireEvent.press(screen.getByTestId('choice-card-choice-other'))
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('other'))
  await fireEvent.press(screen.getByTestId('choice-card-cancel'))
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(null))
})

it('sending: the other buttons wait, so one tap sends one answer', async () => {
  let release: () => void = () => undefined
  const onAnswer = jest.fn(() => new Promise<void>((r) => (release = r)))
  await setup({ onAnswer })
  await fireEvent.press(screen.getByTestId('choice-card-choice-same'))
  await fireEvent.press(screen.getByTestId('choice-card-choice-other'))
  await fireEvent.press(screen.getByTestId('choice-card-cancel'))
  expect(onAnswer).toHaveBeenCalledTimes(1)
  release()
  await waitFor(() => expect(screen.getByTestId('choice-card-choice-other')).toBeTruthy())
})

it('a send that failed says why and can be tried again', async () => {
  const onAnswer = jest.fn().mockRejectedValueOnce(new Error('The computer is offline')).mockResolvedValue(undefined)
  await setup({ onAnswer })
  await fireEvent.press(screen.getByTestId('choice-card-choice-same'))
  await screen.findByText('Could not send your answer: The computer is offline')
  await fireEvent.press(screen.getByTestId('choice-card-choice-same'))
  await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2))
})

it('read-only: the choices as a list and one plain line, no buttons', async () => {
  await setup({ readOnly: 'Open SlicerX on Studio Mac to answer this.' })
  expect(screen.queryByTestId('choice-card-choice-same')).toBeNull()
  expect(screen.queryByTestId('choice-card-cancel')).toBeNull()
  expect(screen.getByText('Yes, that one')).toBeTruthy()
  expect(screen.getByTestId('choice-card-readonly')).toHaveTextContent('Open SlicerX on Studio Mac to answer this.')
})

it('answered: the note in place of the buttons, with the pick marked', async () => {
  await setup({ answered: 'Answered in SlicerX: Yes, that one.', picked: 'same' })
  expect(screen.queryByTestId('choice-card-choice-same')).toBeNull()
  expect(screen.getByTestId('choice-card-answered')).toHaveTextContent('Answered in SlicerX: Yes, that one.')
})

it('a saved card without a handler shows its pick and never offers buttons', async () => {
  await render(<ChoiceCard question="Which plate?" choices={choices} picked="other" />)
  expect(screen.queryByTestId('choice-card-cancel')).toBeNull()
  expect(screen.getByTestId('choice-card-readonly')).toHaveTextContent('Answered')
})
