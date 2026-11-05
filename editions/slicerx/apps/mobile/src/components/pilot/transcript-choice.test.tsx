// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { emptyTranscript, foldEvents, startTurn, type Transcript } from './model'
import { TranscriptList } from './transcript-list'

const asked = (status: 'running' | 'done'): Transcript => {
  let tr = startTurn(emptyTranscript(), { user: 'a wall mount' }, 0)
  tr = foldEvents([{ type: 'ask', askId: 'ask_1', title: 'Confirm the part', question: 'Is this the one?', choices: [{ id: 'same', label: 'Yes' }, { id: 'other', label: 'No' }] } as never], tr)
  return { ...tr, status }
}

const none = () => Promise.resolve()

it("answers a question from this phone's own mimir while its run waits", async () => {
  const onAnswer = jest.fn(() => Promise.resolve())
  await render(<TranscriptList transcript={asked('running')} onApprove={none} onDeny={none} onAnswer={onAnswer} />)
  await fireEvent.press(screen.getByTestId('choice-ask_1-choice-other'))
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('ask_1', 'other'))
  await fireEvent.press(screen.getByTestId('choice-ask_1-cancel'))
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('ask_1', null))
})

it('a question whose run ended stays read-only and says it was not answered', async () => {
  await render(<TranscriptList transcript={asked('done')} onApprove={none} onDeny={none} onAnswer={jest.fn()} />)
  expect(screen.queryByTestId('choice-ask_1-cancel')).toBeNull()
  expect(screen.getByTestId('choice-ask_1-readonly')).toHaveTextContent('This question was not answered.')
})
