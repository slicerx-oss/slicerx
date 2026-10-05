// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Screen frame, section headers, hairlines and list rows. Sections are separated by 1px lines
// and space instead of boxes.
import type { ReactElement, ReactNode } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { haptic } from './feedback'
import { Icon, type IconName } from './icon'
import { Txt } from './text'
import { font, t } from './theme'

export interface ScreenHeaderProps {
  title: string
  /** One short line under the title: counts, the updated time. */
  subtitle?: string | undefined
  /** Icon buttons on the right. */
  actions?: ReactNode | undefined
  /** Left slot, such as a back button when the screen is pushed. */
  leading?: ReactNode | undefined
}

/** The large title row at the top of a tab. */
export function ScreenHeader({ title, subtitle, actions, leading }: ScreenHeaderProps) {
  return (
    <View style={styles.header}>
      {leading}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt variant="title" role="heading" numberOfLines={1} style={{ fontSize: 26, lineHeight: 32, fontFamily: font.bodyBold }}>
          {title}
        </Txt>
        {subtitle ? (
          <Txt variant="caption" tone="muted" numberOfLines={1}>
            {subtitle}
          </Txt>
        ) : null}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  )
}

export interface ScreenProps {
  header?: ReactElement | undefined
  children: ReactNode
  refreshing?: boolean | undefined
  onRefresh?: (() => void) | undefined
  /** Content that sits under the scroll area, above the home indicator (a composer, a send bar). */
  footer?: ReactNode | undefined
  scroll?: boolean | undefined
  testID?: string | undefined
}

/** Safe area, background and an optional pull to refresh scroll view. */
export function Screen({ header, children, refreshing, onRefresh, footer, scroll = true, testID }: ScreenProps) {
  const insets = useSafeAreaInsets()
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={{ paddingBottom: footer ? t.space(2) : insets.bottom + t.space(4) }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing === true}
            onRefresh={() => {
              haptic.snap()
              onRefresh()
            }}
            tintColor={t.color.muted}
            colors={[t.color.purple]}
            progressBackgroundColor={t.color.ink2}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: 1 }}>{children}</View>
  )
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]} testID={testID}>
      {header}
      {body}
      {footer ? <View style={{ paddingBottom: insets.bottom }}>{footer}</View> : null}
    </View>
  )
}

export function Hairline({ inset = 0, style }: { inset?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth * 2, backgroundColor: t.color.lineSoft, marginLeft: inset }, style]} />
}

/** Small label over a group of rows, with an optional count or action on the right. */
export function SectionLabel({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <View style={styles.section}>
      <Txt variant="caption" tone="dim" role="heading" style={{ fontFamily: font.bodySemi, letterSpacing: 0.3 }}>
        {label}
      </Txt>
      {right}
    </View>
  )
}

export interface RowProps {
  title: string
  detail?: string | undefined
  /** Mono detail for numbers, file names and codes. */
  mono?: boolean | undefined
  icon?: IconName | undefined
  iconColor?: string | undefined
  /** Left slot that replaces the icon, such as a thumbnail. */
  leading?: ReactNode | undefined
  trailing?: ReactNode | undefined
  /** Shows a chevron when the row opens something. */
  chevron?: boolean | undefined
  onPress?: (() => void) | undefined
  onLongPress?: (() => void) | undefined
  destructive?: boolean | undefined
  accessibilityHint?: string | undefined
  testID?: string | undefined
}

export function Row({ title, detail, mono, icon, iconColor, leading, trailing, chevron, onPress, onLongPress, destructive, accessibilityHint, testID }: RowProps) {
  const inner = (
    <>
      {leading ?? (icon ? <Icon name={icon} size={22} color={iconColor ?? (destructive ? t.color.red : t.color.muted)} /> : null)}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Txt variant="bodyMedium" color={destructive ? t.color.red : t.color.fg} numberOfLines={1}>
          {title}
        </Txt>
        {detail ? (
          <Txt variant={mono ? 'mono' : 'caption'} tone="muted" numberOfLines={2}>
            {detail}
          </Txt>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Icon name="chevron-right" size={18} color={t.color.dim} /> : null}
    </>
  )
  if (!onPress && !onLongPress) {
    return (
      <View style={styles.row} testID={testID}>
        {inner}
      </View>
    )
  }
  return (
    <Pressable
      role="button"
      accessibilityHint={accessibilityHint}
      testID={testID}
      onPress={onPress}
      onLongPress={
        onLongPress
          ? () => {
              haptic.snap()
              onLongPress()
            }
          : undefined
      }
      style={({ pressed }) => [styles.row, pressed ? { backgroundColor: t.color.ink2 } : null]}
    >
      {inner}
    </Pressable>
  )
}

export interface EmptyStateProps {
  icon: IconName
  title: string
  detail?: string | undefined
  action?: ReactNode | undefined
}

export function EmptyState({ icon, title, detail, action }: EmptyStateProps) {
  return (
    <View style={styles.empty} testID="empty-state">
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={26} color={t.color.dim} />
      </View>
      <Txt variant="heading" align="center">
        {title}
      </Txt>
      {detail ? (
        <Txt variant="caption" tone="muted" align="center" style={{ maxWidth: 300 }}>
          {detail}
        </Txt>
      ) : null}
      {action ? <View style={{ marginTop: t.space(1) }}>{action}</View> : null}
    </View>
  )
}

/** Label and value, value in mono. For temps, times, grams. */
export function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ gap: 2, minWidth: 0 }}>
      <Txt variant="caption" tone="dim" numberOfLines={1}>
        {label}
      </Txt>
      <Txt variant="monoLarge" color={color ?? t.color.fg} numberOfLines={1}>
        {value}
      </Txt>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.color.ink0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: t.space(1), paddingHorizontal: t.gutter, paddingTop: t.space(1), paddingBottom: t.space(1.5), minHeight: 56 },
  actions: { flexDirection: 'row', alignItems: 'center', marginRight: -t.space(1) },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: t.gutter, paddingTop: t.space(3), paddingBottom: t.space(1) },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.space(1.5), minHeight: 56, paddingHorizontal: t.gutter, paddingVertical: t.space(1.25) },
  empty: { alignItems: 'center', gap: t.space(1), paddingHorizontal: t.space(4), paddingVertical: t.space(6) },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, borderWidth: 1, borderColor: t.color.line, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', marginBottom: t.space(1) },
})
