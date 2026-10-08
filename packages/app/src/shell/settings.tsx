// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings: sections that features add (Account) and the base's own (Phone access, Look and feel).
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Dialog, Icon, Switch, type IconName } from '@slicerx/ui'
import { lazy, Suspense, useState } from 'react'
import { useEdition, appName } from '../edition'
import { useFeatures } from '../features'
import { bridgeConnector } from '../link/bridge'
import { LookSettingsSection } from '../first-run/look-settings'

import { usePhoneAccess, usePhoneState, type PhoneAccess } from '../lib/phone'
import { PairDialog } from '../features/phone/pair-dialog'
import { PendingRemovals, RemoteRows } from '../features/phone/remote-rows'
import { set, useApp } from '../state/store'

const PHONE_ID = 'phone'
const PilotSettingsSection = lazy(() => import('../pilot-connect/connect-panel').then((m) => ({ default: m.PilotSettingsSection })))
const PresetsSection = lazy(() => import('../presets/section').then((m) => ({ default: m.PresetsSection })))
const BridgeSection = lazy(() => import('../link/section').then((m) => ({ default: m.BridgeSection })))
const BRIDGE_ID = 'bridge'
const ConnectedAppsSection = lazy(() => import('../connected-apps/section').then((m) => ({ default: m.ConnectedAppsSection })))
const APPS_ID = 'apps'
const ControlsSection = lazy(() => import('../controls/section').then((m) => ({ default: m.ControlsSection })))
const CONTROLS_ID = 'controls'
const PRESETS_ID = 'presets'
const LOOK_ID = 'look'
const PILOT_ID = 'pilot'

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const want = useApp((s) => s.settingsSection)
  const { settings } = useFeatures()
  const edition = useEdition()
  const [picked, setPicked] = useState<string | null>(null)
  const hasBridge = bridgeConnector() !== null
  const sections: { id: string; label: string; icon: IconName }[] = [
    ...settings.map((s) => ({ id: s.id, label: s.label, icon: s.icon })),
    ...(edition.features.phonePairing ? [{ id: PHONE_ID, label: 'Phone access', icon: 'phone' as IconName }] : []),
    ...(hasBridge
      ? [
          { id: BRIDGE_ID, label: 'Printer bridge', icon: 'connect-lan' as IconName },
          { id: APPS_ID, label: 'Connected apps', icon: 'plugin' as IconName },
        ]
      : []),
    { id: PRESETS_ID, label: 'Presets', icon: 'save' },
    { id: CONTROLS_ID, label: 'Controls', icon: 'keyboard' },
    { id: LOOK_ID, label: 'Look and feel', icon: 'sliders' },
    ...(settings.some((s) => s.id === PILOT_ID) ? [] : [{ id: PILOT_ID, label: ASSISTANT_NAME, icon: 'mimir' as IconName }]),
  ]
  const id = [want, picked].find((x) => x && sections.some((s) => s.id === x)) ?? sections[0]?.id
  const close = () => set({ settingsOpen: false, settingsSection: null })
  const Feature = settings.find((s) => s.id === id)?.component ?? null
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Settings"
      size="lg"
      className="settings-dialog"
      splitFooter
      footer={
        <>
          <Button variant="ghost" onClick={() => set({ settingsOpen: false, settingsSection: null, aboutOpen: true })}>
            About {edition.brand.name}
          </Button>
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      <div className="settings">
        {sections.length > 1 ? (
          <nav className="settings-nav" aria-label="Settings sections">
            {sections.map((s) => (
              <button key={s.id} type="button" aria-current={id === s.id ? 'true' : undefined} onClick={() => setPicked(s.id)}>
                <Icon name={s.icon} />
                {s.label}
              </button>
            ))}
          </nav>
        ) : null}
        <div className="settings-body">
          {id === CONTROLS_ID ? (
            <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
              <ControlsSection />
            </Suspense>
          ) : id === BRIDGE_ID ? (
            <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
              <BridgeSection />
            </Suspense>
          ) : id === APPS_ID ? (
            <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
              <ConnectedAppsSection />
            </Suspense>
          ) : id === PRESETS_ID ? (
            <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
              <PresetsSection />
            </Suspense>
          ) : id === LOOK_ID ? (
            <LookSettingsSection />
          ) : id === PILOT_ID && !settings.some((s) => s.id === PILOT_ID) ? (
            <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
              <PilotSettingsSection />
            </Suspense>
          ) : id === PHONE_ID ? (
            <PhoneAccessSection />
          ) : Feature ? (
            <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
              <Feature />
            </Suspense>
          ) : (
            <p className="sx-muted">Nothing to set here yet.</p>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

function PhoneAccessSection() {
  const phone = usePhoneAccess()
  return (
    <section className="set-sec" aria-labelledby="phone-h">
      <h3 id="phone-h">Phone access</h3>
      <PhoneRows phone={phone} />
      <RemoteRows />
    </section>
  )
}

export function PhoneRows({ phone }: { phone: PhoneAccess | null }) {
  const state = usePhoneState(phone)
  const on = state.status === 'on' || state.status === 'starting'
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState(false)
  const toggle = async (next: boolean) => {
    if (!phone) return
    setBusy(true)
    try {
      await phone.setEnabled(next)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="sx-switchrow">
        <label htmlFor="phone-access">
          Phone access on this network
          <small>Lets the {appName()} phone app on your Wi-Fi find this computer. Off by default. It stops when you close the app.</small>
        </label>
        <Switch id="phone-access" checked={on} disabled={!phone || busy} onChange={(v) => void toggle(v)} />
      </div>
      {!phone ? <p className="sx-small sx-muted">This build has no local network bridge. Use the desktop app, or start {appName()} Link, to turn this on.</p> : null}
      {state.status === 'starting' ? <p className="sx-small sx-muted" role="status">Starting the listener.</p> : null}
      {state.status === 'error' ? (
        <p className="app-err" role="alert">
          Phone access did not start: {state.error}
        </p>
      ) : null}
      {state.status === 'on' ? (
        <p className="sx-small" role="status">
          Listening on {state.urls.length ? <span className="sx-mono">{state.urls.map((u) => u.replace(/^ws:\/\//, '').replace(/\/pair$/, '')).join(', ')}</span> : 'this network'}.
        </p>
      ) : null}
      {state.status === 'on' && phone ? (
        <p>
          <Button onClick={() => setPairing(true)}>Pair a phone</Button>
        </p>
      ) : null}
      {pairing && phone ? <PairDialog phone={phone} onClose={() => setPairing(false)} /> : null}
      <h4 className="set-sub">Paired phones</h4>
      {state.devices.length ? (
        <ul className="dev-list">
          {state.devices.map((d) => (
            <li key={d.id}>
              <Icon name="phone" />
              <span className="min0">
                <b>{d.name}</b>
                <small className="sx-muted">{d.online ? 'Connected now' : d.lastSeenAt ? `Last seen ${ago(d.lastSeenAt)}` : 'Not seen yet'}</small>
              </span>
              <Button size="sm" onClick={() => void phone?.revoke(d.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sx-small sx-muted">No phones paired yet.</p>
      )}
      <PendingRemovals />
    </>
  )
}
