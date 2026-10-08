// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Connected apps: services on this network that SlicerX works with, each added once. The hub
// keeps the address; a key goes to the secrets store and only its name is kept. Spoolman moved here from
// Printer bridge with its behavior unchanged. A printer that goes through an app (BamBuddy) can choose it
// as its connection once the app is added. Home Assistant is experimental: its card shows only while the
// hub's experimental connectors are on, and that switch is here, in Developer mode.
import { Button, Chip, Input, Pill, Switch, tipAttrs } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { useHost } from '../host'
import { SpoolmanRows } from '../inventory/spoolman-settings'
import { liveBridge, type BridgeServices, type ConnectedBridge } from '../link/bridge'
import { set, toast, useApp } from '../state/store'
import { appKeyName, appUrl, connectedApp, EXPERIMENTAL_TIP, visibleApps, type ConnectedApp, type ConnectedAppId } from './registry'
import { refreshConnectedApps, useConnectedApps } from './state'

type Check = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; count: number } | { state: 'bad'; message: string }

/** Why an app did not answer, in plain words. */
export function checkReason(app: ConnectedApp, e: unknown): string {
  const t = e instanceof Error ? e.message : String(e)
  // "Long-lived access token" reads mid-sentence as "long-lived access token"; "API key" stays as it is.
  const key = app.key ? app.key.label.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase()) : 'key'
  if (/experimental/i.test(t)) return t
  if (/401|403|unauthori[sz]ed|forbidden|api key|token is not set|auth/i.test(t)) return `${app.name} refused the ${key}. Make a new one in ${app.name} and enter it again.`
  if (/unreachable|connect|timed out|timeout|refused/i.test(t)) return `${app.name} did not answer at that address. Check the address and port, and that ${app.name} is running.`
  return t || `${app.name} did not answer.`
}

/** How many entities a `home-assistant.list_entities` answer lists. */
export function countEntities(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length
  if (raw && typeof raw === 'object') {
    const list = Object.values(raw as Record<string, unknown>).find(Array.isArray)
    if (list) return list.length
  }
  return 0
}

/** "1 printer", "3 spools": the count an app's status line shows. */
export const countLine = (app: ConnectedApp, n: number): string => `${n} ${n === 1 ? app.counts.one : app.counts.many}`

/** Whether the hub accepts experimental connectors, and a way to change it, when the hub says. */
function useExperimental(bridge: ConnectedBridge | undefined): { on: boolean; known: boolean; setOn: (v: boolean) => Promise<void> } {
  const [on, setOnState] = useState(false)
  const [known, setKnown] = useState(false)
  const hub = bridge?.hubSettings
  useEffect(() => {
    let live = true
    if (!hub) {
      setKnown(false)
      return
    }
    void hub.get().then(
      (s) => {
        if (!live) return
        setOnState(s.experimentalConnectors)
        setKnown(true)
      },
      () => live && setKnown(false),
    )
    return () => {
      live = false
    }
  }, [hub])
  const setOn = async (v: boolean) => {
    if (!hub) return
    const s = await hub.set({ experimentalConnectors: v })
    setOnState(s.experimentalConnectors)
  }
  return { on, known, setOn }
}

export function ConnectedAppsSection() {
  const on = useApp((s) => s.bridgeStatus.state === 'on')
  const developer = useApp((s) => s.settingsMode === 'developer')
  const host = useHost()
  useConnectedApps()
  const bridge = on ? (liveBridge() ?? undefined) : undefined
  const services = bridge?.services
  const experimental = useExperimental(bridge)
  const shown = visibleApps(experimental.on)

  // How each keyed app says it answers: BamBuddy has its own check, Home Assistant lists its entities.
  const counters: Partial<Record<ConnectedAppId, (() => Promise<number>) | null>> = {
    bambuddy: services?.check ? () => services.check!('bambuddy').then((r) => r.printers) : null,
    'home-assistant': host.printers?.callTool ? async () => countEntities(await host.printers!.callTool('home-assistant', 'list_entities', {})) : null,
  }

  return (
    <section className="set-sec" aria-labelledby="apps-h" data-testid="connected-apps">
      <h3 id="apps-h">Connected apps</h3>
      <p className="sx-small sx-muted">Apps on your network that SlicerX works with. Add one once; its address stays on this computer and a key goes to the system keychain. Printers and spools work as before until you add an app.</p>
      {services ? (
        <>
          {shown.map((app) =>
            app.id === 'spoolman' ? (
              <div key={app.id} className="watch-rows" data-testid="connected-app-spoolman">
                <SpoolmanRows services={services} />
              </div>
            ) : (
              <KeyedAppRows key={app.id} app={app} services={services} count={counters[app.id] ?? null} />
            ),
          )}
          {developer && experimental.known ? (
            <div className="watch-rows app-experimental">
              <p className="app-experimental-row">
                <span>
                  <b>Try experimental connectors</b>
                  <br />
                  <span className="sx-small sx-muted">Connectors and apps not yet tested on real hardware, such as Home Assistant. They may not work. Developer mode only.</span>
                </span>
                <Switch
                  id="connected-apps-experimental"
                  label="Try experimental connectors"
                  testId="connected-apps-experimental"
                  checked={experimental.on}
                  onChange={(v) =>
                    void experimental.setOn(v).then(
                      () => toast(v ? 'Experimental connectors are on.' : 'Experimental connectors are off.', 'info'),
                      (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'),
                    )
                  }
                />
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="sx-small">
          Connected apps go through the printer bridge.{' '}
          <Button variant="ghost" size="sm" onClick={() => set({ settingsSection: 'bridge' })}>
            Connect the printer bridge
          </Button>
        </p>
      )}
    </section>
  )
}

/** An app with an address and a key (BamBuddy, Home Assistant): add, status, test, edit and remove. */
function KeyedAppRows({ app, services, count }: { app: ConnectedApp; services: BridgeServices; count: (() => Promise<number>) | null }) {
  const host = useHost()
  const apps = useApp((s) => s.connectedApps)
  const saved = apps.find((a) => a.id === app.id) ?? null
  const id = app.id
  const keyLabel = app.key?.label ?? 'Key'
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<Check>({ state: 'idle' })

  const test = useCallback(async () => {
    if (!count) return
    setCheck({ state: 'busy' })
    try {
      setCheck({ state: 'ok', count: await count() })
    } catch (e) {
      setCheck({ state: 'bad', message: checkReason(app, e) })
    }
  }, [count, app])

  const savedUrl = saved?.baseUrl
  useEffect(() => {
    if (savedUrl) void test()
    else setCheck({ state: 'idle' })
    // `test` changes with every render of the section; the saved address is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedUrl])

  const startEdit = () => {
    setAddress(saved ? saved.baseUrl.replace(/^http:\/\//, '') : '')
    setKey('')
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    setError(null)
    const r = appUrl(app, address)
    if ('error' in r) return setError(r.error)
    const typed = key.trim()
    if (!typed && !saved?.hasSecret) return setError(`Enter the ${app.name} ${keyLabel.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase())}.`)
    setBusy(true)
    try {
      const name = appKeyName(id)
      if (typed) await host.secrets.set(name, typed)
      await services.configure(id as 'bambuddy' | 'home-assistant', r.url, name)
      await refreshConnectedApps()
      setEditing(false)
      setKey('')
      toast(saved ? `Saved ${app.name}.` : id === 'bambuddy' ? `Added ${app.name}. Its printers can choose it as their connection.` : `Added ${app.name}.`, 'info')
    } catch (e) {
      setError(checkReason(app, e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setError(null)
    try {
      await services.remove(id)
      await host.secrets.delete(appKeyName(id)).catch(() => undefined)
      await refreshConnectedApps()
      setEditing(false)
      toast(`Removed ${app.name}.`, 'info')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const form = (
    <form
      className="preset-save app-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="sr-only" htmlFor={`${id}-url`}>
        {app.name} address
      </label>
      <Input id={`${id}-url`} data-testid={`connected-app-${id}-address`} className="sx-mono" placeholder={app.addressPlaceholder} value={address} autoComplete="off" spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
      <label className="sr-only" htmlFor={`${id}-key`}>
        {app.name} {keyLabel}
      </label>
      <Input id={`${id}-key`} data-testid={`connected-app-${id}-key`} type="password" placeholder={saved?.hasSecret ? `${keyLabel} (leave empty to keep the saved one)` : (app.key?.placeholder ?? keyLabel)} value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
      <Button type="submit" variant="primary" data-testid={`connected-app-${id}-save`} disabled={busy || !address.trim()}>
        {saved ? 'Save' : `Add ${app.name}`}
      </Button>
      {saved ? (
        <Button variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      ) : null}
    </form>
  )

  return (
    <div className="watch-rows" data-testid={`connected-app-${id}`}>
      <h4>
        {app.name}
        {app.experimental ? (
          <>
            {' '}
            <Chip tone="orange" tabIndex={0} {...tipAttrs({ title: 'Experimental', body: EXPERIMENTAL_TIP })} data-testid={`connected-app-${id}-experimental`}>
              Experimental
            </Chip>
          </>
        ) : null}
      </h4>
      <p className="sx-small sx-muted">{app.blurb}</p>
      {saved && !editing ? (
        <>
          <p>
            <Pill data-testid={`connected-app-${id}-status`} state={check.state === 'ok' ? 'ok' : check.state === 'bad' ? 'bad' : check.state === 'busy' ? 'run' : 'off'}>
              {check.state === 'ok' ? 'Connected' : check.state === 'bad' ? 'Not answering' : check.state === 'busy' ? 'Testing' : 'Added'}
            </Pill>{' '}
            <span className="sx-small sx-mono">{saved.baseUrl}</span>
          </p>
          {check.state === 'ok' ? <p className="sx-small sx-muted">{countLine(app, check.count)} in {app.name}.</p> : null}
          {check.state === 'bad' ? (
            <p className="app-err" role="alert">
              {check.message}
            </p>
          ) : null}
          <p className="bridge-forget app-actions">
            {count ? (
              <Button size="sm" data-testid={`connected-app-${id}-test`} disabled={check.state === 'busy'} onClick={() => void test()}>
                Test connection
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" data-testid={`connected-app-${id}-edit`} onClick={startEdit}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" className="app-remove" data-testid={`connected-app-${id}-remove`} onClick={() => void remove()}>
              Remove {app.name}
            </Button>
          </p>
        </>
      ) : (
        form
      )}
      {error ? (
        <p className="app-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Exported for tests: the app a card is for. */
export const appFor = connectedApp
