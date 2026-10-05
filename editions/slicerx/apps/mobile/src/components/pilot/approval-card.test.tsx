// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ApprovalRequest } from '@slicerx/contracts'
import { ApprovalCard } from './approval-card'

const NOW = Date.UTC(2026, 8, 30, 12, 0)
const request: ApprovalRequest = {
  id: 'a1',
  sessionId: 's1',
  tool: 'bambu.lan.queue',
  permission: 'queue',
  title: 'Send 1 plate to Bay 2?',
  lines: ['12 cable clips on Bay 2, 1h 52m'],
  paramsHash: 'x',
  actions: [],
  expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
}


async function setup(overrides: Partial<Parameters<typeof ApprovalCard>[0]> = {}) {
  const onApprove = jest.fn(() => Promise.resolve())
  const onDeny = jest.fn(() => Promise.resolve())
  await render(<ApprovalCard request={request} resolution={null} actionable onApprove={onApprove} onDeny={onDeny} now={() => NOW} {...overrides} />)
  return { onApprove, onDeny }
}

it('shows the question, the lines, the rule and the countdown', async () => {
  await setup()
  expect(screen.getByText('Send 1 plate to Bay 2?')).toBeTruthy()
  expect(screen.getByText('12 cable clips on Bay 2, 1h 52m')).toBeTruthy()
  expect(screen.getByText('Queue jobs')).toBeTruthy()
  expect(screen.getByText('Expires in 5:00')).toBeTruthy()
})

it('approves with one tap', async () => {
  const { onApprove } = await setup()
  await fireEvent.press(screen.getByTestId('approval-approve'))
  await waitFor(() => expect(onApprove).toHaveBeenCalledWith(request, { bedClear: false }))
})

it('shows why an approval failed and can be tried again', async () => {
  const onApprove = jest.fn().mockRejectedValueOnce(new Error('The computer is offline')).mockResolvedValue(undefined)
  await setup({ onApprove })
  await fireEvent.press(screen.getByTestId('approval-approve'))
  await screen.findByText('The computer is offline')
  await fireEvent.press(screen.getByTestId('approval-approve'))
  await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(2))
})

it('denies with one tap', async () => {
  const { onDeny, onApprove } = await setup()
  await fireEvent.press(screen.getByTestId('approval-deny'))
  await waitFor(() => expect(onDeny).toHaveBeenCalledWith(request))
  expect(onApprove).not.toHaveBeenCalled()
})

it('has no buttons on a card from a saved log', async () => {
  await setup({ actionable: false })
  expect(screen.queryByTestId('approval-approve')).toBeNull()
  expect(screen.getByText('Waiting for an answer')).toBeTruthy()
})

it('shows how a resolved card ended', async () => {
  await setup({ resolution: { decision: { kind: 'deny' }, by: 'user', at: NOW } })
  expect(screen.getByText('Denied. Nothing was sent')).toBeTruthy()
  expect(screen.queryByTestId('approval-approve')).toBeNull()
})

it('disables Approve once the request expired', async () => {
  await setup({ now: () => NOW + 6 * 60_000 })
  expect(screen.getByTestId('approval-approve')).toBeDisabled()
  expect(screen.getByText('Expired')).toBeTruthy()
})

it('names the device that asked', async () => {
  await setup({ requestedBy: 'Workshop tablet' })
  expect(screen.getByText('Asked from Workshop tablet')).toBeOnTheScreen()
})

it('a card that starts a print asks about the bed and cannot approve until it is confirmed', async () => {
  const start: ApprovalRequest = { ...request, id: 'a2', permission: 'start', actions: [{ action: 'printer.start', target: 'bay-2', paramsHash: 'y' }] }
  const { onApprove } = await setup({ request: start })
  await fireEvent.press(screen.getByTestId('approval-approve'))
  expect(onApprove).not.toHaveBeenCalled()
  await fireEvent(screen.getByTestId('approval-bed-clear'), 'valueChange', true)
  await fireEvent.press(screen.getByTestId('approval-approve'))
  await waitFor(() => expect(onApprove).toHaveBeenCalledWith(start, { bedClear: true }))
})

it('offers no Approve when the phone may only deny it from here', async () => {
  await setup({ blocked: 'Approve this at home or in SlicerX' })
  expect(screen.getByText('Approve this at home or in SlicerX')).toBeOnTheScreen()
  expect(screen.queryByTestId('approval-approve')).toBeNull()
  expect(screen.getByTestId('approval-deny')).toBeOnTheScreen()
})
