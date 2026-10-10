// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings, Printer bridge, Devices: the keys the hub remembers for partner apps, AI agents and
// detectors, with Revoke, which also cuts the connection that key has open. Never the keys themselves.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Icon, type IconName } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { liveBridge, type RememberedClient } from './bridge'
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
    </>
  )
}
