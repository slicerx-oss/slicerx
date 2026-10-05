// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bottom tab bar: icons, each with a short label under it, the active tab in purple. Pass it as
// the navigator's tabBar and map the route state onto these props.
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { haptic } from './feedback'
import { Icon, type IconName } from './icon'
import { Txt } from './text'
import { font, t } from './theme'

export interface TabItem {
  key: string
  icon: IconName
  label: string
  /** Dot for something waiting there, such as an approval. */
  badge?: boolean | undefined
}

export interface TabBarProps {
  tabs: readonly TabItem[]
  active: string
  onSelect: (key: string) => void
  /** A second tap on the active tab, used to scroll to top. */
  onReselect?: ((key: string) => void) | undefined
}

export function TabBar({ tabs, active, onSelect, onReselect }: TabBarProps) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]} role="tablist">
      {tabs.map((tab) => {
        const on = tab.key === active
        const color = on ? t.color.purple : t.color.dim
        return (
          <Pressable
            key={tab.key}
            role="tab"
            aria-selected={on}
            aria-label={tab.badge ? `${tab.label}, needs you` : tab.label}
            testID={`tab-${tab.key}`}
            onPress={() => {
              if (on) {
                onReselect?.(tab.key)
                return
              }
              haptic.select()
              onSelect(tab.key)
            }}
            style={styles.tab}
          >
            <View>
              <Icon name={tab.icon} size={24} color={color} stroke={on ? 2 : 1.75} />
              {tab.badge ? <View style={styles.badge} /> : null}
            </View>
            <Txt variant="caption" color={color} style={{ fontSize: 11, lineHeight: 14, fontFamily: on ? font.bodySemi : font.bodyMedium }} numberOfLines={1}>
              {tab.label}
            </Txt>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: t.color.lineSoft, backgroundColor: t.color.ink0, paddingTop: 6 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: t.hit },
  badge: { position: 'absolute', top: -1, right: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: t.color.purple, borderWidth: 1.5, borderColor: t.color.ink0 },
})
