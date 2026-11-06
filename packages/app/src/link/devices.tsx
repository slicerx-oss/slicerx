// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings, Printer bridge, Devices: the keys the hub remembers for partner apps, AI agents and
// detectors, with Revoke, which also cuts the connection that key has open. Never the keys themselves.
// Partner phones (another company's phone app, paired under its name) are listed here too, with whether each
// may approve prints, pauses and skips (never what a partner app asked for), and Revoke.
// Below them, the partner routes open now (a partner app's sealed byte stream to its own phone), with
// End route. Sizes and times only.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Dialog, Icon, Select, SwitchRow, type IconName } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { liveBridge, type PartnerRouteRow, type RememberedClient } from './bridge'
import { toast } from '../state/store'
import { usePhoneAccess, usePhoneState, type PhoneDevice } from '../lib/phone'
import { PairDialog } from '../features/phone/pair-dialog'
import { appName } from '../edition'

function kind(c: RememberedClient): { label: string; icon: IconName } {
  if (c.partner) return { label: 'Partner app', icon: 'plugin' }
  if (c.role === 'watch') return { label: 'Print watch detector', icon: 'detection' }
  return { label: 'AI agent', icon: 'terminal' }
}

function seen(at: string | null): string {
  if (!at) return 'not used yet'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000))
  if (s < 60) return 'used just now'
  if (s < 3600) return `last used ${Math.round(s / 60)} min ago`
  if (s < 86400) return `last used ${Math.round(s / 3600)} h ago`
  return `last used ${Math.round(s / 86400)} d ago`
}

// Two keys for one app read apart by when each was made.
const made = (at: string): string => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function size(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`
}

function openFor(at: number): string {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (m < 1) return 'just opened'
  if (m < 60) return `${m} min`
  return `${Math.round(m / 60)} h`
}

/** The partner routes open now, each closable. Nothing shows while none is open. */
function PartnerRouteRows() {
  const routes = liveBridge()?.partnerRoutes ?? null
  const [rows, setRows] = useState<PartnerRouteRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => {
    if (!routes) return
    routes.list().then(setRows, () => setRows([]))
  }, [routes])
  useEffect(() => {
    load()
    return routes?.onChanged?.(load)
  }, [load, routes])
  if (!routes || rows.length === 0) return null

  const close = async (r: PartnerRouteRow) => {
    setBusy(r.routeId)
    try {
      await routes.close(r.routeId)
      toast(`Ended the route from ${r.app} to ${r.phone ?? 'its phone'}.`, 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The bridge did not end the route.', 'warn')
    } finally {
      setBusy(null)
      load()
    }
  }

  return (
    <>
      <h4 className="set-sub">Partner routes</h4>
      <p className="sx-small sx-muted">A partner app's connection to its own phone through the relay. It reaches no printer. End one to close it right away.</p>
      <ul className="dev-list" data-testid="partner-routes">
        {rows.map((r) => (
          <li key={r.routeId} data-testid={`partner-route-${r.routeId}`}>
            <Icon name="plugin" />
            <span className="min0">
              <b>
                {r.app} to {r.phone ?? 'its phone'}
              </b>
              <small className="sx-muted">
                {r.state === 'opening' ? 'opening' : openFor(r.openedAt)}, {size(r.bytesIn)} in, {size(r.bytesOut)} out
              </small>
            </span>
            <Button size="sm" data-testid={`partner-route-close-${r.routeId}`} disabled={busy === r.routeId} onClick={() => void close(r)}>
              End route
            </Button>
          </li>
        ))}
      </ul>
    </>
  )
}

export function DeviceRows() {
  const clients = liveBridge()?.clients ?? null
  const [rows, setRows] = useState<RememberedClient[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => {
    if (!clients) return
    clients.list().then(
      (all) => setRows(all.filter((c) => c.role !== 'app')),
      () => setRows([]),
    )
  }, [clients])
  useEffect(load, [load])
  if (!clients) return null

  const revoke = async (c: RememberedClient) => {
    setBusy(c.id)
    try {
      await clients.revoke(c.id)
      toast(`Revoked the key for ${c.name}. It is disconnected now.`, 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The bridge did not revoke the key.', 'warn')
    } finally {
      setBusy(null)
      load()
    }
  }

  const partnerKeys = (rows ?? []).filter((c) => c.partner).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt }))
  return (
    <>
      <h4 className="set-sub">Devices</h4>
      <p className="sx-small sx-muted">Partner apps, AI agents and detectors that hold a key to this bridge. Revoking a key disconnects it right away.</p>
      {rows === null ? null : rows.length ? (
        <ul className="dev-list" data-testid="devices-list">
          {rows.map((c) => {
            const k = kind(c)
            return (
              <li key={c.id} data-testid={`device-${c.id}`}>
                <Icon name={k.icon} />
                <span className="min0">
                  <b>{c.name}</b>
                  <small className="sx-muted">
                    {k.label}, made {made(c.createdAt)}, {seen(c.lastSeenAt)}
                  </small>
                </span>
                <Button size="sm" data-testid={`device-revoke-${c.id}`} disabled={busy === c.id} onClick={() => void revoke(c)}>
                  Revoke
                </Button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="sx-small sx-muted" data-testid="devices-empty">
          No keys yet. Make one in Settings, {ASSISTANT_NAME}, Connect your AI agent.
        </p>
      )}
      <PartnerPhoneRows keys={partnerKeys} />
      <PartnerRouteRows />
    </>
  )
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

const seenPhone = (d: PhoneDevice): string => (d.online ? 'connected now' : d.lastSeenAt ? `last seen ${ago(d.lastSeenAt)}` : 'not seen yet')

/** How partner names compare everywhere (pair's partnerKey, sx-link's partner_key). */
const fold = (n: string): string => n.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

/** A partner app key as the link select offers it. */
interface PartnerKey {
  id: string
  name: string
  createdAt: string
}

/**
 * Partner phones: pair one, decide what it may do beyond seeing and asking to pause or stop, link it to the partner
 * app key on this computer that may reach it, and revoke it.
 */
export function PartnerPhoneRows({ keys = [] }: { keys?: PartnerKey[] }) {
  const phone = usePhoneAccess()
  const state = usePhoneState(phone)
  const remote = liveBridge()?.remote ?? null
  const [pairing, setPairing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // The partner app key each partner phone is linked to on the hub (Remote access only).
  const [links, setLinks] = useState<Record<string, string | null> | null>(null)
  const [ask, setAsk] = useState<{ device: PhoneDevice; key: PartnerKey } | null>(null)
  const ids = state.devices.map((d) => d.id).join(',')
  useEffect(() => {
    if (!remote) return
    remote.pairings.list().then(
      (all) => setLinks(Object.fromEntries(all.filter((p) => p.partner !== undefined).map((p) => [p.pairingId, p.partnerClient ?? null]))),
      () => setLinks(null),
    )
  }, [remote, ids])
  if (!phone) return null
  const on = state.status === 'on' || state.status === 'starting'
  const list = state.devices.filter((d) => d.partner !== undefined)

  const run = async (d: PhoneDevice, what: () => Promise<unknown>, done?: string) => {
    setBusy(d.id)
    try {
      await what()
      if (done) toast(done, 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not go through.', 'warn')
    } finally {
      setBusy(null)
    }
  }
  const link = (d: PhoneDevice, clientId: string | null, mismatchOk = false) =>
    run(d, async () => {
      await remote?.pairings.link?.(d.id, clientId, mismatchOk ? { mismatchOk: true } : undefined)
      setLinks((l) => ({ ...(l ?? {}), [d.id]: clientId }))
    })
  // A key named otherwise than the phone: ask before linking (the hub refuses it otherwise).
  const pick = (d: PhoneDevice, clientId: string | null) => {
    const k = keys.find((x) => x.id === clientId)
    if (k && d.partner !== undefined && fold(k.name) !== fold(d.partner)) setAsk({ device: d, key: k })
    else void link(d, clientId)
  }

  return (
    <>
      <h4 className="set-sub">Partner phones</h4>
      <p className="sx-small sx-muted">
        Phone apps from other makers that work with {appName()}. Each sees your printers and their cameras and can ask to pause or stop a print, also away from home when Remote access is on. It approves nothing and sends no prints unless you allow it here. Its name is what the app calls itself; {appName()} can&apos;t check who made it.
      </p>
      {list.length ? (
        <ul className="dev-list" data-testid="partner-phones">
          {list.map((d) => (
            <li key={d.id} className="dev-partner" data-testid={`partner-phone-${d.id}`}>
              <Icon name="phone" />
              <span className="min0">
                <b>{d.partner}</b>
                <small className="sx-muted">
                  Partner phone on {d.name}, {seenPhone(d)}
                </small>
              </span>
              <Button size="sm" data-testid="partner-phone-revoke" disabled={busy === d.id} onClick={() => void run(d, () => phone.revoke(d.id), `Removed ${d.partner ?? d.name}. It is disconnected now.`)}>
                Revoke
              </Button>
              <div className="dev-rights">
                <SwitchRow
                  id={`partner-approve-${d.id}`}
                  testId="partner-phone-approve-row"
                  label="Approve prints, pauses and skips"
                  detail="Never what a partner app asks for itself. It also answers mimir's questions."
                  checked={d.approve === true}
                  disabled={busy === d.id || !phone.setPartnerRights}
                  onChange={(v) => void run(d, () => phone.setPartnerRights?.(d.id, { approve: v }) ?? Promise.resolve())}
                />
                <SwitchRow
                  id={`partner-send-${d.id}`}
                  testId="partner-phone-send-row"
                  label="Send prints and see your library"
                  detail="Each print still waits for you to approve it on this computer."
                  checked={d.send === true}
                  disabled={busy === d.id || !phone.setPartnerRights}
                  onChange={(v) => void run(d, () => phone.setPartnerRights?.(d.id, { send: v }) ?? Promise.resolve())}
                />
                <div className="sx-switchrow">
                  <label htmlFor={`partner-key-${d.id}`}>
                    Its app on this computer
                    <small>{links && d.id in links ? 'Only the key you pick here can open a private channel to this phone.' : 'Turn on Remote access to link this phone to a partner app key.'}</small>
                  </label>
                  <Select id={`partner-key-${d.id}`} size="sm" data-testid="partner-phone-key" disabled={busy === d.id || !links || !(d.id in links) || !remote?.pairings.link} value={links?.[d.id] ?? ''} onChange={(e) => pick(d, e.target.value || null)}>
                    <option value="">Not linked</option>
                    {keys.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}, key made {made(k.createdAt)}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sx-small sx-muted" data-testid="partner-phones-empty">
          No partner phones yet.
        </p>
      )}
      {on ? (
        <p>
          <Button data-testid="partner-phone-pair" onClick={() => setPairing(true)}>
            Pair a partner phone
          </Button>
        </p>
      ) : (
        <p className="sx-small sx-muted">Turn on Phone access in Settings, Phone access, to pair a partner phone.</p>
      )}
      {pairing ? <PairDialog phone={phone} partner known={[...new Set(keys.map((k) => k.name))]} onClose={() => setPairing(false)} /> : null}
      <Dialog
        open={ask !== null}
        onClose={() => setAsk(null)}
        title="Link to a key with another name?"
        footer={
          <>
            <Button variant="ghost" data-testid="partner-link-dont" onClick={() => setAsk(null)}>
              Don&apos;t link
            </Button>
            <Button
              variant="primary"
              data-testid="partner-link-anyway"
              onClick={() => {
                const a = ask
                setAsk(null)
                if (a) void link(a.device, a.key.id, true)
              }}
            >
              Link anyway
            </Button>
          </>
        }
      >
        <p>
          This phone says it&apos;s {ask?.device.partner}. Link it to the key {ask?.key.name} anyway?
        </p>
        <p className="sx-small sx-muted">That key could then open a private channel to this phone. Names are what each app calls itself, so link only if you know both are the same app.</p>
      </Dialog>
    </>
  )
}
