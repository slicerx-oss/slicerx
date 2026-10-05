// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ApprovalRequest } from '@slicerx/contracts'
import { ComputerApprovalSheet, headingFor, type PendingComputerApproval } from './computer-approval-sheet'

const NOW = Date.UTC(2026, 8, 30, 12, 0)
const req = (id: string, title: string): ApprovalRequest => ({
  id,
  sessionId: 's',
  tool: 'printer.start',
  permission: 'start',
  title,
  lines: ['Benchy, 42 min'],
  paramsHash: 'x',
  actions: [],
  expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
})
const item = (id: string, title: string, over: Partial<PendingComputerApproval> = {}): PendingComputerApproval => ({
  id,
  hostName: 'Studio Mac',
  request: req(id, title),
  source: 'pilot',
  decide: jest.fn(() => Promise.resolve()),
  ...over,
})

it('shows the first request and names the computer', async () => {
  await render(<ComputerApprovalSheet pending={[item('a', 'Start Benchy on Bay 1?'), item('b', 'Second')]} onSettled={jest.fn()} now={() => NOW} />)
  expect(screen.getByText('Start Benchy on Bay 1?')).toBeTruthy()
  expect(screen.getByText('mimir on Studio Mac needs your approval')).toBeTruthy()
  expect(screen.getByText('2 requests waiting')).toBeTruthy()
})

it('signs the approval with one tap', async () => {
  const a = item('a', 'Start Benchy on Bay 1?')
  const onSettled = jest.fn()
  await render(<ComputerApprovalSheet pending={[a]} onSettled={onSettled} now={() => NOW} />)
  fireEvent.press(screen.getByTestId('approval-approve'))
  await waitFor(() => expect(a.decide).toHaveBeenCalledWith('approve', { bedClear: false }))
  expect(onSettled).toHaveBeenCalledWith('a')
})

it('keeps the request open when signing fails', async () => {
  const a = item('a', 'Start Benchy on Bay 1?', { decide: jest.fn(() => Promise.reject(new Error('The computer is offline'))) })
  const onSettled = jest.fn()
  await render(<ComputerApprovalSheet pending={[a]} onSettled={onSettled} now={() => NOW} />)
  fireEvent.press(screen.getByTestId('approval-approve'))
  expect(await screen.findByText('The computer is offline')).toBeTruthy()
  expect(onSettled).not.toHaveBeenCalled()
})

it('denies with one tap', async () => {
  const a = item('a', 'Start Benchy on Bay 1?')
  const onSettled = jest.fn()
  await render(<ComputerApprovalSheet pending={[a]} onSettled={onSettled} now={() => NOW} />)
  fireEvent.press(screen.getByTestId('approval-deny'))
  await waitFor(() => expect(a.decide).toHaveBeenCalledWith('deny'))
  expect(onSettled).toHaveBeenCalledWith('a')
})

it('words the heading by who asked', () => {
  expect(headingFor({ hostName: 'Mac', source: 'pilot' })).toBe('mimir on Mac needs your approval')
  expect(headingFor({ hostName: 'Mac', source: 'pair', requestedBy: 'Sam iPad' })).toBe('Sam iPad asks Mac')
  expect(headingFor({ hostName: 'Mac', source: 'host' })).toBe('Mac needs your approval')
})
