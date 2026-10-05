// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Three tabs. Printers is home; mimir is reached from a printer, not from here.
import { Tabs } from 'expo-router'
import type { IconName } from '../../src/components/icon'
import { TabBar } from '../../src/components/tab-bar'
import { t } from '../../src/components/theme'
import { usePocket } from '../../src/state/store'

const TABS: { key: string; label: string; icon: IconName }[] = [
  { key: 'index', label: 'Printers', icon: 'printer' },
  { key: 'library', label: 'Library', icon: 'library' },
  { key: 'account', label: 'Account', icon: 'settings' },
]

export default function TabsLayout() {
  const attention = usePocket((s) => s.waiting.length > 0 || s.alerts.some((a) => !a.read && a.kind !== 'finished'))
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: t.color.ink0 } }}
      tabBar={({ state, navigation }) => (
        <TabBar
          tabs={TABS.map((tab) => (tab.key === 'index' ? { ...tab, badge: attention } : tab))}
          active={state.routes[state.index]?.name ?? 'index'}
          onSelect={(key) => navigation.navigate(key)}
        />
      )}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.key} name={tab.key} options={{ title: tab.label }} />
      ))}
    </Tabs>
  )
}
