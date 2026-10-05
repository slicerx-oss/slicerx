// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen } from '@testing-library/react-native'
import { NOTIFICATIONS, NOW } from './fixtures'
import { NotificationsScreen, groupByDay, type NotificationsScreenProps } from './notifications-screen'

function props(over: Partial<NotificationsScreenProps> = {}): NotificationsScreenProps {
  return { items: NOTIFICATIONS, loading: false, refreshing: false, onRefresh: jest.fn(), onOpen: jest.fn(), onMarkAllRead: jest.fn(), onBack: jest.fn(), now: NOW, ...over }
}

it('groups by local day, newest first', async () => {
  expect(groupByDay(NOTIFICATIONS, NOW).map((g) => [g.title, g.data.map((n) => n.id)])).toEqual([
    ['Today', ['n1', 'n2']],
    ['Yesterday', ['n3']],
  ])
})

it('counts unread and marks all as read', async () => {
  const p = props()
  await render(<NotificationsScreen {...p} />)
  expect(screen.getByText('2 unread')).toBeTruthy()
  await fireEvent.press(screen.getByTestId('mark-all-read'))
  expect(p.onMarkAllRead).toHaveBeenCalled()
})

it('opens a notification', async () => {
  const p = props()
  await render(<NotificationsScreen {...p} />)
  await fireEvent.press(screen.getByTestId('note-n2'))
  expect(p.onOpen).toHaveBeenCalledWith(NOTIFICATIONS[1])
})

it('says when there is nothing new', async () => {
  await render(<NotificationsScreen {...props({ items: [] })} />)
  expect(screen.getByText('Nothing new')).toBeTruthy()
  expect(screen.queryByTestId('mark-all-read')).toBeNull()
})
