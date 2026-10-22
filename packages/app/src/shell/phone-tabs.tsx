// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab bar at the bottom of a phone: Model, the workspaces the top bar would show, and mimir when the assistant is
// on. mimir is the plate workspace in its own mode, the chat under the design's view, so going back to Model or Slice
// never rebuilds the view. With one tab left there is nothing to switch, and the bar is not drawn at all
// (--phone-tabbar-h goes to 0).
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Icon, type IconName } from '@slicerx/ui'
import { useEffect } from 'react'
import { useHasFeature } from '../features'
import { usePhoneLayout } from '../lib/phone-layout'
import { useInMimir } from '../state/model-mode'
import { setModelMode, useApp } from '../state/store'
import { usePhoneKeyboard } from './phone-keyboard'
import { openTab, useShellTabs } from './top-bar'
import './phone-shell.css'

type Item = { id: string; label: string; icon: IconName; status?: 'ok' | 'warn'; current: boolean; go: () => void }

export function PhoneTabs() {
  const phone = usePhoneLayout()
  const { shown, cad, activeTab } = useShellTabs()
  const assistant = useHasFeature('pilot')
  const mimir = useInMimir()
  const onPlate = useApp((s) => s.workspace === 'prepare')
  const items: Item[] = [
    ...(cad ? [{ id: 'model', label: 'Model', icon: 'model' as IconName, current: !mimir && onPlate, go: () => setModelMode('design') }] : []),
    ...shown.map((t) => ({
      id: t.id,
      label: t.label,
      icon: t.icon,
      ...(t.status ? { status: t.status } : {}),
      current: activeTab === t.id,
      go: () => openTab(t.id),
    })),
    ...(assistant ? [{ id: 'mimir', label: ASSISTANT_NAME, icon: 'mimir' as IconName, current: mimir, go: () => setModelMode('mimir') }] : []),
  ]
  const on = phone && items.length > 1
  useEffect(() => {
    const root = document.documentElement
    if (on) root.setAttribute('data-phone-tabs', '')
    else root.removeAttribute('data-phone-tabs')
    return () => root.removeAttribute('data-phone-tabs')
  }, [on])
  usePhoneKeyboard(phone)
  if (!on) return null
  return (
    <nav className="phone-tabs" aria-label="Sections" data-testid="phone-tabs">
      {items.map((t) => (
        <button key={t.id} type="button" className="phone-tab" data-tab={t.id} data-testid={`tab-${t.id}`} aria-current={t.current ? 'page' : undefined} onClick={t.go}>
          <span className="phone-tab-ic" aria-hidden="true">
            <Icon name={t.icon} size={24} />
            {t.status ? <i className={t.status === 'warn' ? 'sx-dot warn phone-tab-dot' : 'sx-dot phone-tab-dot'} /> : null}
          </span>
          <span className="phone-tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
