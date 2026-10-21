// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings: sections that features add (Account) and the base's own (Phone access, Look and feel).
import { Button, Dialog, Icon, Switch } from '@slicerx/ui'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useEdition, appName } from '../edition'
import { useFeatures } from '../features'
import { LookSettingsSection, SlicingSettingsSection } from '../first-run/look-settings'

import { usePhoneAccess, usePhoneState, type PhoneAccess } from '../lib/phone'
import { PairDialog } from '../features/phone/pair-dialog'
import { PendingRemovals, RemoteRows } from '../features/phone/remote-rows'
import { set, useApp } from '../state/store'
import { Loading } from './loading'
import { AGENTS_ID, APPS_ID, BRIDGE_ID, CONTROLS_ID, LOOK_ID, MEMORY_ID, PHONE_ID, PILOT_ID, PRESETS_ID, settingsSections, SLICING_ID } from './settings-sections'
import { usePhoneLayout } from '../lib/phone-layout'

const PilotSettingsSection = lazy(() => import('../pilot-connect/settings-section').then((m) => ({ default: m.PilotSettingsSection })))
const PresetsSection = lazy(() => import('../presets/section').then((m) => ({ default: m.PresetsSection })))
const BridgeSection = lazy(() => import('../link/section').then((m) => ({ default: m.BridgeSection })))
const ConnectedAppsSection = lazy(() => import('../connected-apps/section').then((m) => ({ default: m.ConnectedAppsSection })))
const ControlsSection = lazy(() => import('../controls/section').then((m) => ({ default: m.ControlsSection })))
const MemorySection = lazy(() => import('../pilot-connect/memory-section').then((m) => ({ default: m.MemorySection })))
const AgentsSection = lazy(() => import('../app-link/section').then((m) => ({ default: m.AgentsSection })))

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const want = useApp((s) => s.settingsSection)
  const { settings } = useFeatures()
  const edition = useEdition()
  const [picked, setPicked] = useState<string | null>(null)
  const sections = settingsSections(edition, settings)
  const id = [want, picked].find((x) => x && sections.some((s) => s.id === x)) ?? sections[0]?.id
  // A phone opens on the list of sections, and a section on its own page with Back; a section asked for from
  // elsewhere opens straight on its page.
  const phone = usePhoneLayout()
  const listed = phone && sections.length > 1 && !(want && sections.some((s) => s.id === want)) && !(picked && sections.some((s) => s.id === picked))
  const back = () => {
    setPicked(null)
    set({ settingsSection: null })
  }
  useEffect(() => {
    if (!open) setPicked(null)
  }, [open])
  // On a phone the sections are one scrolling row. Opening Settings, or a section opened from elsewhere, brings that
  // tab fully into view; a tap on the row never moves it. An edge with more tabs past it fades out rather than cutting
  // a tab in half.
  const nav = useRef<HTMLElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })
  const measure = () => {
    const n = nav.current
    if (n) setEdges({ start: n.scrollLeft > 1, end: n.scrollLeft + n.clientWidth < n.scrollWidth - 1 })
  }
  useLayoutEffect(() => {
    if (open) nav.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, want])
  // the row's size settles after the dialog opens and the fonts load, so the edges are measured again then
  useEffect(() => {
    const n = nav.current
    if (!open || !n || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(n)
    for (const c of n.children) ro.observe(c)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
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
        phone ? null : (
        <>
          <Button variant="ghost" onClick={() => set({ settingsOpen: false, settingsSection: null, aboutOpen: true })}>
            About {edition.brand.name}
          </Button>
          <Button onClick={close}>Close</Button>
        </>
        )
      }
    >
      {listed ? (
        <nav aria-label="Settings sections">
        <ul className="settings-list" data-testid="settings-list">
          {sections.map((s) => (
            <li key={s.id}>
              <button type="button" data-testid={`settings-nav-${s.id}`} onClick={() => setPicked(s.id)}>
                <Icon name={s.icon} />
                {s.label}
                <Icon name="chevron-right" className="settings-list-go" />
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="settings-list-about" onClick={() => set({ settingsOpen: false, settingsSection: null, aboutOpen: true })}>
              <Icon name="info" />
              About {edition.brand.name}
              <Icon name="chevron-right" className="settings-list-go" />
            </button>
          </li>
        </ul>
        </nav>
      ) : (
      <div className="settings">
        {phone && sections.length > 1 ? (
          <button type="button" className="settings-back" data-testid="settings-back" onClick={back}>
            <Icon name="chevron-left" />
            All settings
          </button>
        ) : null}
        {sections.length > 1 && !phone ? (
          <nav ref={nav} className="settings-nav" aria-label="Settings sections" onScroll={measure} data-more-start={edges.start || undefined} data-more-end={edges.end || undefined}>
            {sections.map((s) => (
              <button key={s.id} type="button" data-testid={`settings-nav-${s.id}`} aria-current={id === s.id ? 'true' : undefined} onClick={() => setPicked(s.id)}>
                <Icon name={s.icon} />
                {s.label}
              </button>
            ))}
          </nav>
        ) : null}
        <div className="settings-body">
          {id === CONTROLS_ID ? (
            <Suspense fallback={<Loading />}>
              <ControlsSection />
            </Suspense>
          ) : id === BRIDGE_ID ? (
            <Suspense fallback={<Loading />}>
              <BridgeSection />
            </Suspense>
          ) : id === AGENTS_ID ? (
            <Suspense fallback={<Loading />}>
              <AgentsSection />
            </Suspense>
          ) : id === APPS_ID ? (
            <Suspense fallback={<Loading />}>
              <ConnectedAppsSection />
            </Suspense>
          ) : id === PRESETS_ID ? (
            <Suspense fallback={<Loading />}>
              <PresetsSection />
            </Suspense>
          ) : id === LOOK_ID ? (
            <LookSettingsSection />
          ) : id === SLICING_ID ? (
            <SlicingSettingsSection />
          ) : id === PILOT_ID && !settings.some((s) => s.id === PILOT_ID) ? (
            <Suspense fallback={<Loading />}>
              <PilotSettingsSection />
            </Suspense>
          ) : id === MEMORY_ID ? (
            <Suspense fallback={<Loading />}>
              <MemorySection />
            </Suspense>
          ) : id === PHONE_ID ? (
            <PhoneAccessSection />
          ) : Feature ? (
            <Suspense fallback={<Loading />}>
              <Feature />
            </Suspense>
          ) : (
            <p className="sx-muted">Nothing to set here yet.</p>
          )}
        </div>
      </div>
      )}
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
