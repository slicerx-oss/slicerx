// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { QuestionCard } from '../data/mimir-questions'
import { ComputerQuestionSheet } from './computer-question-sheet'

const card = (over: Partial<QuestionCard> = {}): QuestionCard => ({
  pairingId: 'pc-1',
  hostName: 'Studio Mac',
  question: { v: 1, sessionId: 's_1', askId: 'ask_1', title: 'Confirm the part', question: 'Is this the one?', choices: [{ id: 'same', label: 'Yes' }, { id: 'other', label: 'No' }], at: 1 },
  reach: 'live',
  ...over,
})

it('shows the computer and answers through it', async () => {
  const onAnswer = jest.fn(() => Promise.resolve())
  await render(<ComputerQuestionSheet questions={[card()]} onAnswer={onAnswer} onClose={jest.fn()} />)
  expect(screen.getByText('mimir has a question')).toBeTruthy()
  expect(screen.getByText('mimir on Studio Mac asks')).toBeTruthy()
  await fireEvent.press(screen.getByTestId('computer-question-choice-same'))
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('pc-1', 'same'))
})

it.each([
  ['closed', 'Open SlicerX on Studio Mac to answer this.'],
  ['unreachable', "Can't reach Studio Mac right now."],
  ['unsupported', 'Answer this in SlicerX on Studio Mac.'],
] as const)('%s: read-only with one line', async (reach, line) => {
  await render(<ComputerQuestionSheet questions={[card({ reach })]} onAnswer={jest.fn()} onClose={jest.fn()} />)
  expect(screen.queryByTestId('computer-question-choice-same')).toBeNull()
  expect(screen.getByTestId('computer-question-readonly')).toHaveTextContent(line)
})

it('answered here or elsewhere: the note in place of the buttons', async () => {
  await render(<ComputerQuestionSheet questions={[card({ answered: 'Answered on Tablet: No.' })]} onAnswer={jest.fn()} onClose={jest.fn()} />)
  expect(screen.getByTestId('computer-question-answered')).toHaveTextContent('Answered on Tablet: No.')
})
