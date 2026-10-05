// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { AccountScreen, initials, type AccountScreenProps } from './account-screen'

function props(over: Partial<AccountScreenProps> = {}): AccountScreenProps {
  return {
    account: { name: 'Riley Vance', email: 'riley@example.com', plan: 'Member' },
    push: { kind: 'on', hostName: 'Studio Mac' },
    policy: DEFAULT_POLICY,
    onPolicyChange: jest.fn(() => Promise.resolve()),
    notifications: { printDone: true, printFailed: true, attention: true, approvals: true },
    onNotificationsChange: jest.fn(),
    haptics: true,
    onHapticsChange: jest.fn(),
    pairedCount: 2,
    onOpenPairing: jest.fn(),
    signInMethods: ['email'],
    onSignInWithEmail: jest.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    onSignInWithProvider: jest.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    onSignOut: jest.fn(),
    data: {
      policy: { graceDays: 30, removed: ['Your profile'], kept: ['Print records'] },
      pending: null,
      onExport: jest.fn(() => Promise.resolve()),
      onRequestDeletion: jest.fn(() => Promise.resolve()),
      onCancelDeletion: jest.fn(() => Promise.resolve()),
    },
    version: '0.1.0 (12)',
    ...over,
  }
}

it('makes initials from a name', async () => {
  expect(initials('Riley Vance')).toBe('RV')
  expect(initials('  sam ')).toBe('S')
})

it('lets mimir slice without asking with one switch', async () => {
  const p = props()
  await render(<AccountScreen {...p} />)
  await fireEvent(screen.getByTestId('perm-slice'), 'valueChange', false)
  await waitFor(() => expect(p.onPolicyChange).toHaveBeenCalledWith('slice', 'ask'))
})

it('never offers to skip the question before a printer or a profile changes', async () => {
  await render(<AccountScreen {...props()} />)
  expect(screen.queryByTestId('perm-queue')).toBeNull()
  expect(screen.queryByTestId('perm-start')).toBeNull()
  expect(screen.queryByText(/Buy filament|spends money/)).toBeNull()
})

it('shows why a permission did not save', async () => {
  const p = props({ onPolicyChange: jest.fn(() => Promise.reject(new Error('No connection. Try again'))) })
  await render(<AccountScreen {...p} />)
  await fireEvent(screen.getByTestId('perm-slice'), 'valueChange', false)
  expect(await screen.findByText('No connection. Try again')).toBeOnTheScreen()
})

it('says how alerts reach the phone while the app is closed', async () => {
  const { rerender } = await render(<AccountScreen {...props()} />)
  expect(screen.getByText('On, sent by Studio Mac')).toBeOnTheScreen()
  await rerender(<AccountScreen {...props({ push: { kind: 'no-hub' } })} />)
  expect(screen.getByText('Needs a paired computer running SlicerX')).toBeOnTheScreen()
})

it('signs in by email with a magic link when signed out', async () => {
  const p = props({ account: null })
  await render(<AccountScreen {...p} />)
  expect(screen.getByTestId('sign-in-send')).toBeDisabled()
  expect(screen.queryByTestId('sign-in-github')).toBeNull()
  await fireEvent.changeText(screen.getByTestId('sign-in-email'), ' riley@example.com ')
  await fireEvent.press(screen.getByTestId('sign-in-send'))
  expect(await screen.findByText('Check your email')).toBeOnTheScreen()
  expect(p.onSignInWithEmail).toHaveBeenCalledWith('riley@example.com')
  expect(screen.queryByTestId('sign-out')).toBeNull()
})

it('shows provider buttons only for methods the edition offers', async () => {
  const p = props({ account: null, signInMethods: ['email', 'github'] })
  await render(<AccountScreen {...p} />)
  await fireEvent.press(screen.getByTestId('sign-in-github'))
  expect(p.onSignInWithProvider).toHaveBeenCalledWith('github')
})

it('shows the store error when sign-in is refused', async () => {
  const p = props({ account: null, onSignInWithEmail: jest.fn(() => Promise.resolve({ ok: false as const, code: 'unavailable' as const, message: 'No connection. Try again' })) })
  await render(<AccountScreen {...p} />)
  await fireEvent.changeText(screen.getByTestId('sign-in-email'), 'riley@example.com')
  await fireEvent.press(screen.getByTestId('sign-in-send'))
  expect(await screen.findByText('No connection. Try again')).toBeOnTheScreen()
})

it('says sign-in is unavailable in builds without it', async () => {
  await render(<AccountScreen {...props({ account: null, signInMethods: [] })} />)
  expect(screen.getByTestId('sign-in-unavailable')).toBeOnTheScreen()
  expect(screen.queryByTestId('sign-in-email')).toBeNull()
})

describe('your data', () => {
  it('hides export and deletion when signed out', async () => {
    await render(<AccountScreen {...props({ account: null })} />)
    expect(screen.queryByTestId('export-data')).toBeNull()
    expect(screen.queryByTestId('delete-account')).toBeNull()
  })

  it('exports on tap', async () => {
    const p = props()
    await render(<AccountScreen {...p} />)
    await fireEvent.press(screen.getByTestId('export-data'))
    await waitFor(() => expect(p.data.onExport).toHaveBeenCalledTimes(1))
  })

  it('shows why an export failed', async () => {
    const p = props()
    p.data.onExport = jest.fn(() => Promise.reject(new Error('No connection. Try again')))
    await render(<AccountScreen {...p} />)
    await fireEvent.press(screen.getByTestId('export-data'))
    expect(await screen.findByText('No connection. Try again')).toBeOnTheScreen()
  })

  it('states what deletion removes and keeps, and asks for one confirmation', async () => {
    const p = props()
    await render(<AccountScreen {...p} />)
    await fireEvent.press(screen.getByTestId('delete-account'))
    expect(screen.getByText('Your account is deleted after 30 days. Sign in before then to cancel.')).toBeOnTheScreen()
    expect(screen.getByText('Removed: Your profile')).toBeOnTheScreen()
    expect(screen.getByText('Kept: Print records')).toBeOnTheScreen()
    expect(p.data.onRequestDeletion).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByTestId('delete-sheet-confirm'))
    await waitFor(() => expect(p.data.onRequestDeletion).toHaveBeenCalledTimes(1))
  })

  it('does not request deletion when the sheet is closed', async () => {
    const p = props()
    await render(<AccountScreen {...p} />)
    await fireEvent.press(screen.getByTestId('delete-account'))
    await fireEvent.press(screen.getByTestId('delete-sheet-close'))
    expect(p.data.onRequestDeletion).not.toHaveBeenCalled()
  })

  it('offers to cancel a pending deletion', async () => {
    const p = props()
    p.data.pending = { purgeAfter: '2026-10-30T00:00:00Z' }
    await render(<AccountScreen {...p} />)
    expect(screen.getByTestId('deletion-pending')).toBeOnTheScreen()
    expect(screen.queryByTestId('delete-account')).toBeNull()
    await fireEvent.press(screen.getByTestId('cancel-deletion'))
    await waitFor(() => expect(p.data.onCancelDeletion).toHaveBeenCalledTimes(1))
  })
})
