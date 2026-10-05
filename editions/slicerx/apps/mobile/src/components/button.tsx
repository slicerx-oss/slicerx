// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Buttons. Primary is solid purple; one per screen. Danger is for cancel print and unlink.
import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { haptic } from './feedback'
import { Icon, type IconName } from './icon'
import { Txt } from './text'
import { font, t } from './theme'

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps {
  label: string
  onPress: () => void
  kind?: ButtonKind | undefined
  icon?: IconName | undefined
  size?: 'md' | 'lg' | undefined
  disabled?: boolean | undefined
  busy?: boolean | undefined
  /** Stretch to the row. */
  block?: boolean | undefined
  /** Spoken instead of the label when the label alone is ambiguous ("Pause Bay 1"). */
  accessibilityLabel?: string | undefined
  testID?: string | undefined
  style?: StyleProp<ViewStyle> | undefined
}

const FG: Record<ButtonKind, string> = {
  primary: t.color.onGrad,
  secondary: t.color.fg,
  ghost: t.color.muted,
  danger: t.color.red,
}

export function Button({ label, onPress, kind = 'secondary', icon, size = 'md', disabled, busy, block, accessibilityLabel, testID, style }: ButtonProps) {
  const off = disabled === true || busy === true
  return (
    <Pressable
      role="button"
      aria-label={accessibilityLabel ?? label}
      aria-disabled={off} aria-busy={busy === true}
      disabled={off}
      testID={testID}
      onPress={() => {
        haptic.tap()
        onPress()
      }}
      style={({ pressed }) => [
        styles.base,
        size === 'lg' ? styles.lg : styles.md,
        styles[kind],
        block ? styles.block : null,
        pressed && !off ? styles.pressed : null,
        off ? styles.off : null,
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={FG[kind]} /> : icon ? <Icon name={icon} size={18} color={FG[kind]} /> : null}
      <Txt variant="label" color={FG[kind]} style={{ fontFamily: font.bodySemi }} numberOfLines={1}>
        {label}
      </Txt>
    </Pressable>
  )
}

export interface IconButtonProps {
  icon: IconName
  /** Required: an icon alone has no name for a screen reader. */
  label: string
  onPress: () => void
  color?: string | undefined
  size?: number | undefined
  disabled?: boolean | undefined
  badge?: boolean | undefined
  testID?: string | undefined
}

/** A 44pt target around a 22pt icon, for headers and rows. */
export function IconButton({ icon, label, onPress, color = t.color.muted, size = 22, disabled, badge, testID }: IconButtonProps) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled === true}
      disabled={disabled}
      testID={testID}
      hitSlop={4}
      onPress={() => {
        haptic.tap()
        onPress()
      }}
      style={({ pressed }) => [styles.icon, pressed ? { backgroundColor: t.color.ink3 } : null, disabled ? styles.off : null]}
    >
      <Icon name={icon} size={size} color={color} />
      {badge ? <View style={styles.badge} testID={testID ? `${testID}-badge` : undefined} /> : null}
    </Pressable>
  )
}

/** Small round chip for filters and suggestions. */
export function Chip({ label, selected, onPress, icon, testID }: { label: string; selected?: boolean; onPress: () => void; icon?: IconName; testID?: string }) {
  return (
    <Pressable
      role="button"
      aria-selected={selected === true}
      testID={testID}
      onPress={() => {
        haptic.select()
        onPress()
      }}
      style={({ pressed }) => [styles.chip, selected ? styles.chipOn : null, pressed ? { opacity: 0.8 } : null]}
    >
      {icon ? <Icon name={icon} size={16} color={selected ? t.color.purple : t.color.muted} /> : null}
      <Txt variant="label" color={selected ? t.color.fg : t.color.muted} numberOfLines={1}>
        {label}
      </Txt>
    </Pressable>
  )
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>
}

const styles = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space(1), borderRadius: t.radius.md, borderWidth: 1 },
  md: { minHeight: t.hit, paddingHorizontal: t.space(2) },
  lg: { minHeight: 52, paddingHorizontal: t.space(3) },
  block: { alignSelf: 'stretch', flexGrow: 1 },
  primary: { backgroundColor: t.color.purple, borderColor: t.color.purple },
  secondary: { backgroundColor: t.color.ink3, borderColor: t.color.line },
  ghost: { backgroundColor: 'transparent', borderColor: 'transparent' },
  danger: { backgroundColor: t.color.redTint, borderColor: t.color.redTint },
  pressed: { opacity: 0.82, transform: [{ scale: 0.985 }] },
  off: { opacity: 0.4 },
  icon: { width: t.hit, height: t.hit, borderRadius: t.radius.md, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: 10, right: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: t.color.purple, borderWidth: 1.5, borderColor: t.color.ink0 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.color.lineSoft,
  },
  chipOn: { backgroundColor: t.color.purpleTint, borderColor: t.color.purpleEdge },
  row: { flexDirection: 'row', gap: t.space(1), alignItems: 'center', flexWrap: 'wrap' },
})
