// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print finished, print failed, needs attention and approval requests, newest first by day.
import { SectionList, RefreshControl, StyleSheet, View } from 'react-native'
import { IconButton } from '../components/button'
import { haptic } from '../components/feedback'
import { type IconName } from '../components/icon'
import { EmptyState, Row, Screen, ScreenHeader, SectionLabel } from '../components/layout'
import { fmtClock } from '../components/pilot/model'
import { SkeletonRows } from '../components/status'
import { Txt } from '../components/text'
import { t } from '../components/theme'

export type NotificationKind = 'print_done' | 'print_failed' | 'attention' | 'approval' | 'pilot_done' | 'device'

export interface AppNotification {
  id: string
  kind: NotificationKind
  title: string
  body: string
  at: string
  read: boolean
}

export interface NotificationsScreenProps {
  items: AppNotification[]
  loading: boolean
  refreshing: boolean
  onRefresh: () => void
  onOpen: (n: AppNotification) => void
  onMarkAllRead: () => void
  onBack: () => void
  now?: number
}

const KIND: Record<NotificationKind, { icon: IconName; color: string }> = {
  print_done: { icon: 'check', color: t.color.green },
  print_failed: { icon: 'alert', color: t.color.red },
  attention: { icon: 'warning', color: t.color.orange },
  approval: { icon: 'approval-required', color: t.color.purple },
  pilot_done: { icon: 'pilot', color: t.color.purple },
  device: { icon: 'link', color: t.color.muted },
}

const DAY = 86_400_000

/** Groups into Today, Yesterday and Earlier on the local calendar. */
export function groupByDay(items: AppNotification[], now: number): { title: string; data: AppNotification[] }[] {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  const groups = { Today: [] as AppNotification[], Yesterday: [] as AppNotification[], Earlier: [] as AppNotification[] }
  const sorted = [...items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  for (const n of sorted) {
    const at = Date.parse(n.at)
    if (at >= today) groups.Today.push(n)
    else if (at >= today - DAY) groups.Yesterday.push(n)
    else groups.Earlier.push(n)
  }
  return (Object.keys(groups) as (keyof typeof groups)[]).filter((k) => groups[k].length > 0).map((k) => ({ title: k, data: groups[k] }))
}

function when(iso: string, now: number): string {
  const at = Date.parse(iso)
  const d = new Date(at)
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (at >= start.getTime() - DAY) return fmtClock(at)
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`
}

export function NotificationsScreen(p: NotificationsScreenProps) {
  const now = p.now ?? Date.now()
  const unread = p.items.filter((n) => !n.read).length
  const header = (
    <ScreenHeader
      title="Notifications"
      subtitle={unread > 0 ? `${unread} unread` : undefined}
      leading={<IconButton icon="chevron-left" label="Back" onPress={p.onBack} color={t.color.fg} />}
      actions={unread > 0 ? <IconButton icon="check" label="Mark all as read" onPress={p.onMarkAllRead} testID="mark-all-read" /> : undefined}
    />
  )
  return (
    <Screen header={header} scroll={false} testID="notifications-screen">
      {p.loading ? (
        <SkeletonRows count={5} />
      ) : (
        <SectionList
          sections={groupByDay(p.items, now)}
          keyExtractor={(n) => n.id}
          stickySectionHeadersEnabled={false}
          testID="notifications-list"
          refreshControl={
            <RefreshControl
              refreshing={p.refreshing}
              onRefresh={() => {
                haptic.snap()
                p.onRefresh()
              }}
              tintColor={t.color.muted}
              colors={[t.color.purple]}
              progressBackgroundColor={t.color.ink2}
            />
          }
          renderSectionHeader={({ section }) => <SectionLabel label={section.title} />}
          ListEmptyComponent={<EmptyState icon="notification" title="Nothing new" detail="Finished prints, failures and approval requests show up here." />}
          renderItem={({ item: n }) => {
            const k = KIND[n.kind]
            return (
              <View style={!n.read ? styles.unread : null}>
                <Row
                  icon={k.icon}
                  iconColor={k.color}
                  title={n.title}
                  detail={n.body}
                  trailing={
                    <View style={styles.meta}>
                      <Txt variant="mono" tone="dim" style={{ fontSize: 12 }}>
                        {when(n.at, now)}
                      </Txt>
                      {!n.read ? <View style={styles.dot} aria-label="Unread" /> : null}
                    </View>
                  }
                  onPress={() => p.onOpen(n)}
                  testID={`note-${n.id}`}
                />
              </View>
            )
          }}
        />
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  unread: { backgroundColor: t.color.ink1 },
  meta: { alignItems: 'flex-end', gap: 6, alignSelf: 'flex-start', paddingTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.color.purple },
})
