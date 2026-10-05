// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, renderHook, waitFor } from '@testing-library/react-native'
import { usePairing } from './index'

// The real package pulls in ESM-only crypto that jest does not load; the hook needs only its error type.
jest.mock('@slicerx/pair', () => ({
  PairError: class PairError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))
jest.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()] }))
// One stable host: the hook re-creates its service subscription when the host changes.
jest.mock('../data/provider', () => {
  const host = {}
  return { usePocketHost: () => host }
})

const mockClient = { pair: jest.fn(), joinAccount: jest.fn(), unpair: jest.fn(), watchJoinRequests: jest.fn(() => () => undefined) }
const mockNoHosts: never[] = []
const mockSvc = {
  client: mockClient,
  hosts: () => mockNoHosts,
  onChange: () => () => undefined,
  refresh: jest.fn(() => Promise.resolve()),
  accountRelay: () => Promise.resolve(null),
  watchQuota: () => () => undefined,
  retryRemovals: () => Promise.resolve(0),
}
jest.mock('./service', () => ({ pairService: () => Promise.resolve(mockSvc) }))

/** A flow the test settles by hand. */
function flow(hostName = 'Studio Mac') {
  let sas!: (v: string) => void
  let result!: (v: unknown) => void
  const f = {
    hostName,
    sas: new Promise<string>((r) => (sas = r)),
    result: new Promise((r) => (result = r)),
    confirm: jest.fn(),
    reject: jest.fn(),
  }
  return { f, sas, result }
}

beforeEach(() => {
  mockClient.pair.mockReset()
  mockClient.joinAccount.mockReset()
  mockSvc.refresh.mockClear()
})

async function ready() {
  const hook = await renderHook(() => usePairing())
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

it('starts on the list and moves to scan and type', async () => {
  const { result } = await ready()
  expect(result.current.stage).toEqual({ step: 'list' })
  expect(result.current.camera).toBe('granted')
  await act(async () => result.current.onStartScan())
  expect(result.current.stage).toEqual({ step: 'scan' })
  await act(async () => result.current.onTypeCode())
  expect(result.current.stage).toEqual({ step: 'type' })
})

it('walks connecting, confirm, finishing and done', async () => {
  const { f, sas, result } = flow()
  mockClient.pair.mockResolvedValue(f)
  const { result: hook } = await ready()
  await act(async () => hook.current.onCode('ABCD-EFGH-JKMN'))
  expect(mockClient.pair).toHaveBeenCalledWith('ABCD-EFGH-JKMN')
  expect(hook.current.stage).toEqual({ step: 'connecting' })
  await act(async () => sas('482 913'))
  await waitFor(() => expect(hook.current.stage).toEqual({ step: 'confirm', sas: '482 913', hostName: 'Studio Mac' }))
  await act(async () => hook.current.onConfirm())
  expect(f.confirm).toHaveBeenCalledTimes(1)
  expect(hook.current.stage).toEqual({ step: 'finishing' })
  await act(async () => result({ ok: true, hosts: [{ name: 'Studio Mac' }] }))
  await waitFor(() => expect(hook.current.stage).toEqual({ step: 'done', hostNames: ['Studio Mac'] }))
  expect(mockSvc.refresh).toHaveBeenCalled()
  await act(async () => hook.current.onReset())
  expect(hook.current.stage).toEqual({ step: 'list' })
})

it('rejecting the digits goes back to the list and never confirms', async () => {
  const { f, sas, result } = flow()
  mockClient.pair.mockResolvedValue(f)
  const { result: hook } = await ready()
  await act(async () => hook.current.onCode('ABCD-EFGH-JKMN'))
  await act(async () => sas('111 222'))
  await waitFor(() => expect(hook.current.stage.step).toBe('confirm'))
  await act(async () => hook.current.onReject())
  expect(f.reject).toHaveBeenCalledTimes(1)
  expect(f.confirm).not.toHaveBeenCalled()
  await act(async () => result({ ok: false, reason: 'rejected' }))
  await waitFor(() => expect(hook.current.stage).toEqual({ step: 'list' }))
  expect(mockSvc.refresh).not.toHaveBeenCalled()
})

it('shows the outcome reason when the computer declines', async () => {
  const { f, result } = flow()
  mockClient.pair.mockResolvedValue(f)
  const { result: hook } = await ready()
  await act(async () => hook.current.onCode('ABCD-EFGH-JKMN'))
  await act(async () => result({ ok: false, reason: 'mismatch' }))
  await waitFor(() => expect(hook.current.stage).toEqual({ step: 'error', reason: 'mismatch' }))
})

it('shows a PairError message and hides other errors behind a plain one', async () => {
  const { PairError } = jest.requireMock('@slicerx/pair') as { PairError: new (c: string, m: string) => Error }
  const { result: hook } = await ready()
  mockClient.pair.mockRejectedValueOnce(new PairError('bad_link', 'That code is not valid'))
  await act(async () => hook.current.onCode('x'))
  await waitFor(() => expect(hook.current.stage).toEqual({ step: 'error', reason: 'That code is not valid' }))
  mockClient.pair.mockRejectedValueOnce(new Error('ECONNRESET at 10.0.0.4'))
  await act(async () => hook.current.onCode('x'))
  await waitFor(() => expect(hook.current.stage).toEqual({ step: 'error', reason: 'Pairing could not start' }))
})

it('joins an account and waits for a device to review it', async () => {
  const { f } = flow('')
  mockClient.joinAccount.mockResolvedValue(f)
  const { result: hook } = await ready()
  await act(async () => hook.current.onJoinAccount())
  expect(hook.current.stage).toEqual({ step: 'join-waiting' })
  expect(mockClient.joinAccount).toHaveBeenCalledTimes(1)
})

it('explains when this phone has no computer to add a device to', async () => {
  mockClient.joinAccount.mockResolvedValue(null)
  const { result: hook } = await ready()
  await act(async () => hook.current.onJoinAccount())
  await waitFor(() => expect(hook.current.stage.step).toBe('error'))
})
