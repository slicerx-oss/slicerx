// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings, Printer bridge, Devices: the keys the hub remembers for partner apps, AI agents and
// detectors, with Revoke, which also cuts the connection that key has open. Never the keys themselves.
// Below them, the partner routes open now (a partner app's sealed byte stream to its own phone), with
// End route. Sizes and times only.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Icon, type IconName } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { liveBridge, type PartnerRouteRow, type RememberedClient } from './bridge'
import { toast } from '../state/store'

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
      <PartnerRouteRows />
    </>
  )
}
