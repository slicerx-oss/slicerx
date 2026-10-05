// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen } from '@testing-library/react-native'
import { emptyTranscript, foldEvents, startTurn } from '../components/pilot/model'
import { NOW, RUN_EVENTS, SESSIONS } from './fixtures'
import { PilotScreen, type PilotScreenProps } from './pilot-screen'

function props(over: Partial<PilotScreenProps> = {}): PilotScreenProps {
  return {
    transcript: emptyTranscript(),
    sessions: SESSIONS,
    activeSessionId: 's1',
    connected: true,
    suggestions: [{ id: 'q', label: 'Check my printers', prompt: 'How are my printers doing?' }],
    onSend: jest.fn(),
    onStop: jest.fn(),
    onApprove: jest.fn(() => Promise.resolve()),
    onDeny: jest.fn(() => Promise.resolve()),
    onOpenSession: jest.fn(),
    onNewSession: jest.fn(),
    onOpenNotifications: jest.fn(),
    unreadNotifications: 0,
    now: NOW,
    ...over,
  }
}

const running = () => foldEvents(RUN_EVENTS, startTurn(emptyTranscript(), { user: 'Print 12 cable clips in PETG' }, NOW), NOW)

it('opens on an empty state with suggestions', async () => {
  const p = props()
  await render(<PilotScreen {...p} />)
  expect(screen.getByText('What should we print?')).toBeTruthy()
  await fireEvent.press(screen.getByTestId('suggest-q'))
  expect(p.onSend).toHaveBeenCalledWith('How are my printers doing?')
})

it('sends a trimmed message and clears the field', async () => {
  const p = props()
  await render(<PilotScreen {...p} />)
  expect(screen.getByTestId('pilot-send')).toBeDisabled()
  await fireEvent.changeText(screen.getByTestId('pilot-input'), '  Slice the planter  ')
  await fireEvent.press(screen.getByTestId('pilot-send'))
  expect(p.onSend).toHaveBeenCalledWith('Slice the planter')
  expect(screen.getByTestId('pilot-input').props.value).toBe('')
})

it('renders the run: bubble, folded thinking, tool row, prose and an approval card', async () => {
  await render(<PilotScreen {...props({ transcript: running() })} />)
  expect(screen.getByText('Print 12 cable clips in PETG')).toBeTruthy()
  expect(screen.getByText('Thought for 2.4s')).toBeTruthy()
  expect(screen.queryByText(/Twelve clips fit/)).toBeNull()
  expect(screen.getByText('Bay 2 idle, PETG in slot A3')).toBeTruthy()
  expect(screen.getByText('PETG')).toBeTruthy()
  expect(screen.getByTestId('approval-a1')).toBeTruthy()
})

it('unfolds thinking and tool output on tap', async () => {
  await render(<PilotScreen {...props({ transcript: running() })} />)
  await fireEvent.press(screen.getByTestId('think-toggle'))
  expect(screen.getByText(/Twelve clips fit/)).toBeTruthy()
  await fireEvent.press(screen.getByTestId('tool-c1'))
  expect(screen.getByText('idle, bed clear')).toBeTruthy()
})

it('shows Stop instead of Send while mimir works', async () => {
  const p = props({ transcript: running() })
  await render(<PilotScreen {...p} />)
  await fireEvent.press(screen.getByTestId('pilot-stop'))
  expect(p.onStop).toHaveBeenCalled()
  expect(screen.getByTestId('new-session')).toBeDisabled()
})

it('lists sessions in a sheet and opens one', async () => {
  const p = props()
  await render(<PilotScreen {...p} />)
  await fireEvent.press(screen.getByTestId('open-sessions'))
  await fireEvent.press(screen.getByTestId('session-s2'))
  expect(p.onOpenSession).toHaveBeenCalledWith('s2')
})

it('asks to pair when nothing can run mimir', async () => {
  await render(<PilotScreen {...props({ connected: false })} />)
  expect(screen.getByText('Not connected')).toBeTruthy()
  expect(screen.getByText(/Pair a computer running SlicerX/)).toBeTruthy()
  expect(screen.queryByTestId('suggest-q')).toBeNull()
})
