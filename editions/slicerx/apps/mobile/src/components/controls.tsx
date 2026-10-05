// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Segmented control and switch row.
import { Pressable, StyleSheet, Switch, View } from 'react-native'
import { haptic } from './feedback'
import { Icon, type IconName } from './icon'
import { Txt } from './text'
import { font, t } from './theme'

export interface SegmentOption<V extends string> {
  value: V
  label: string
  icon?: IconName | undefined
  /** Text color when selected, for Allow, Ask first and Off. */
  color?: string | undefined
}

export interface SegmentedProps<V extends string> {
  value: V
  options: readonly SegmentOption<V>[]
  onChange: (v: V) => void
  /** Names the group for screen readers. */
  label: string
  testID?: string | undefined
}

export function Segmented<V extends string>({ value, options, onChange, label, testID }: SegmentedProps<V>) {
  return (
    <View style={styles.seg} role="radiogroup" aria-label={label} testID={testID}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            role="radio"
            aria-checked={on}
            aria-label={o.label}
            testID={testID ? `${testID}-${o.value}` : undefined}
            onPress={() => {
              if (on) return
              haptic.select()
              onChange(o.value)
            }}
            style={[styles.opt, on ? styles.optOn : null]}
          >
            {o.icon ? <Icon name={o.icon} size={16} color={on ? (o.color ?? t.color.fg) : t.color.dim} /> : null}
            <Txt variant="caption" color={on ? (o.color ?? t.color.fg) : t.color.muted} style={{ fontFamily: font.bodySemi }} numberOfLines={1}>
              {o.label}
            </Txt>
          </Pressable>
        )
      })}
    </View>
  )
}

export interface SwitchRowProps {
  title: string
  detail?: string | undefined
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean | undefined
  icon?: IconName | undefined
  testID?: string | undefined
}

export function SwitchRow({ title, detail, value, onChange, disabled, icon, testID }: SwitchRowProps) {
  return (
    <View style={styles.row}>
      {icon ? <Icon name={icon} size={22} color={t.color.muted} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="bodyMedium">{title}</Txt>
        {detail ? (
          <Txt variant="caption" tone="muted">
            {detail}
          </Txt>
        ) : null}
      </View>
      <Switch
        aria-label={title}
        testID={testID}
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          haptic.select()
          onChange(v)
        }}
        trackColor={{ false: t.color.ink4, true: t.color.purple }}
        thumbColor={t.color.fg}
        ios_backgroundColor={t.color.ink4}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  seg: { flexDirection: 'row', padding: 3, gap: 3, borderRadius: t.radius.md, backgroundColor: t.color.ink1, borderWidth: 1, borderColor: t.color.lineSoft },
  opt: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', minHeight: 36, paddingHorizontal: 8, borderRadius: t.radius.sm + 1 },
  optOn: { backgroundColor: t.color.ink3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.space(1.5), minHeight: 56, paddingHorizontal: t.gutter, paddingVertical: t.space(1) },
})
