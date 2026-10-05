// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { HOSTS, JOIN_REQUESTS, NOW } from './fixtures'
import { PairingScreen, formatTypedCode, groupCode, pairFailureMessage, type PairingScreenProps } from './pairing-screen'

function props(over: Partial<PairingScreenProps> = {}): PairingScreenProps {
  return {
    hosts: HOSTS,
    loading: false,
    joinRequests: [],
    stage: { step: 'list' },
    camera: 'granted',
    onRequestCamera: jest.fn(),
    onStartScan: jest.fn(),
    onTypeCode: jest.fn(),
    onCode: jest.fn(),
    onJoinAccount: jest.fn(),
    onReviewJoin: jest.fn(),
    onConfirm: jest.fn(),
    onReject: jest.fn(),
    onReset: jest.fn(),
    onUnpair: jest.fn(() => Promise.resolve()),
    onBack: jest.fn(),
    refreshing: false,
    onRefresh: jest.fn(),
    now: NOW,
    ...over,
  }
}

it('formats codes', () => {
  expect(groupCode('482913')).toBe('482 913')
  expect(groupCode('482 913')).toBe('482 913')
  expect(formatTypedCode('ab3d ef9h-k2m4x')).toBe('AB3D-EF9H-K2M4')
  expect(formatTypedCode('ab3')).toBe('AB3')
})

it('explains known failures and passes other messages through', () => {
  expect(pairFailureMessage('expired')).toMatch(/expired/)
  expect(pairFailureMessage('That code is not valid')).toBe('That code is not valid')
})

it('lists paired hosts, where they slice and who is offline', async () => {
  await render(<PairingScreen {...props()} />)
  expect(screen.getByText('Studio Mac')).toBeOnTheScreen()
  expect(screen.getByText('Slices')).toBeOnTheScreen()
  expect(screen.getByText(/SlicerX desktop online account slices here slices in the cloud/)).toBeOnTheScreen()
  expect(screen.getByText(/SlicerX in a browser seen Yesterday/)).toBeOnTheScreen()
})

it('unpairs a host from its sheet', async () => {
  const p = props()
  await render(<PairingScreen {...p} />)
  await fireEvent.press(screen.getByTestId('host-p2'))
  expect(screen.getByText('Unlink Workshop browser?')).toBeOnTheScreen()
  expect(screen.getByText(/It is offline/)).toBeOnTheScreen()
  await fireEvent.press(screen.getByTestId('unlink-confirm'))
  await waitFor(() => expect(p.onUnpair).toHaveBeenCalledWith('p2'))
})

it('passes a scanned code once', async () => {
  const p = props({ stage: { step: 'scan' } })
  await render(<PairingScreen {...p} />)
  const cam = screen.getByLabelText('Camera. Point it at the QR code on your computer')
  await fireEvent(cam, 'barcodeScanned', { data: 'sx-pair:abc' })
  await fireEvent(cam, 'barcodeScanned', { data: 'sx-pair:abc' })
  expect(p.onCode).toHaveBeenCalledTimes(1)
  expect(p.onCode).toHaveBeenCalledWith('sx-pair:abc')
})

it('takes a typed code once all 12 characters are in', async () => {
  const p = props({ stage: { step: 'type' } })
  await render(<PairingScreen {...p} />)
  await fireEvent.changeText(screen.getByTestId('pair-code-input'), 'ab3def9h')
  expect(screen.getByTestId('pair-code-submit')).toBeDisabled()
  await fireEvent.changeText(screen.getByTestId('pair-code-input'), 'ab3def9hk2m4')
  await fireEvent.press(screen.getByTestId('pair-code-submit'))
  expect(p.onCode).toHaveBeenCalledWith('AB3D-EF9H-K2M4')
})

it('offers typing when the camera is denied', async () => {
  const p = props({ stage: { step: 'scan' }, camera: 'denied' })
  await render(<PairingScreen {...p} />)
  await fireEvent.press(screen.getByTestId('pair-type'))
  expect(p.onTypeCode).toHaveBeenCalled()
})

it('asks the person to compare the digits on both screens', async () => {
  const p = props({ stage: { step: 'confirm', sas: '482 913', hostName: 'Studio Mac' } })
  await render(<PairingScreen {...p} />)
  expect(screen.getByText('Does Studio Mac show these digits?')).toBeOnTheScreen()
  expect(screen.getByTestId('pair-code')).toHaveTextContent('482 913')
  await fireEvent.press(screen.getByTestId('pair-mismatch'))
  expect(p.onReject).toHaveBeenCalled()
  await fireEvent.press(screen.getByTestId('pair-match'))
  expect(p.onConfirm).toHaveBeenCalled()
})

it('waits for another device when joining an account, and can cancel', async () => {
  const p = props({ stage: { step: 'join-waiting' } })
  await render(<PairingScreen {...p} />)
  expect(screen.getByText('Waiting for approval on a device you already use')).toBeOnTheScreen()
  await fireEvent.press(screen.getByTestId('join-cancel'))
  expect(p.onReject).toHaveBeenCalled()
})

it('shows join requests and hides Review when this phone cannot introduce', async () => {
  const p = props({ joinRequests: [...JOIN_REQUESTS, { requestId: 'j2', name: 'Old laptop', platform: 'web', canReview: false }] })
  await render(<PairingScreen {...p} />)
  await fireEvent.press(screen.getByTestId('join-review-j1'))
  expect(p.onReviewJoin).toHaveBeenCalledWith('j1')
  expect(screen.queryByTestId('join-review-j2')).toBeNull()
})

it('says why pairing failed and offers a retry', async () => {
  const p = props({ stage: { step: 'error', reason: 'mismatch' } })
  await render(<PairingScreen {...p} />)
  expect(screen.getByText(/The codes did not match/)).toBeOnTheScreen()
  await fireEvent.press(screen.getByTestId('pair-retry'))
  expect(p.onStartScan).toHaveBeenCalled()
})

describe('stages', () => {
  it('names the computer while connecting and can cancel', async () => {
    const p = props({ stage: { step: 'connecting', hostName: 'Studio Mac' } })
    await render(<PairingScreen {...p} />)
    expect(screen.getByText('Connecting to Studio Mac')).toBeOnTheScreen()
    await fireEvent.press(screen.getByText('Cancel'))
    expect(p.onReject).toHaveBeenCalled()
  })

  it('connects without a name when none is known', async () => {
    await render(<PairingScreen {...props({ stage: { step: 'connecting' } })} />)
    expect(screen.getByText('Connecting')).toBeOnTheScreen()
  })

  it('says it is finishing after the digits were confirmed', async () => {
    await render(<PairingScreen {...props({ stage: { step: 'finishing' } })} />)
    expect(screen.getByText('Finishing')).toBeOnTheScreen()
    expect(screen.queryByTestId('pair-match')).toBeNull()
  })

  it('lists who was paired and returns to the list', async () => {
    const p = props({ stage: { step: 'done', hostNames: ['Studio Mac', 'Shop PC'] } })
    await render(<PairingScreen {...p} />)
    expect(screen.getByText('Paired with Studio Mac, Shop PC')).toBeOnTheScreen()
    await fireEvent.press(screen.getByTestId('pair-done'))
    expect(p.onReset).toHaveBeenCalled()
  })

  it('shows the type stage with Pair disabled until the code is complete', async () => {
    const p = props({ stage: { step: 'type' } })
    await render(<PairingScreen {...p} />)
    expect(screen.getByTestId('pair-code-submit')).toBeDisabled()
    await fireEvent.changeText(screen.getByTestId('pair-code-input'), 'abcd-efgh-jkmn')
    expect(screen.getByTestId('pair-code-submit')).not.toBeDisabled()
  })

  it('labels a removal the computer has not confirmed and retries it', async () => {
    const first = HOSTS[0]!
    const hosts = [{ ...first, host: { ...first.host, pendingRemoval: true } }, ...HOSTS.slice(1)]
    const onRetryRemovals = jest.fn(() => Promise.resolve(1))
    await render(<PairingScreen {...props({ hosts, onRetryRemovals })} />)
    expect(screen.getByText('Removal pending')).toBeOnTheScreen()
    await fireEvent.press(screen.getByTestId('retry-removals'))
    expect(onRetryRemovals).toHaveBeenCalled()
  })

  it('shows the relay quota when there is one', async () => {
    const quota = { tier: 'account' as const, used: 340 * 1024 ** 2, cap: 5 * 1024 ** 3, resetsAt: Date.UTC(2026, 10, 1), connections: 1, maxConnections: 8 }
    await render(<PairingScreen {...props({ quota })} />)
    expect(screen.getByTestId('remote-quota')).toBeOnTheScreen()
    expect(screen.getByText(/340 MB of 5\.0 GB used this month, resets Nov 1/)).toBeOnTheScreen()
  })
})
