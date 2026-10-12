// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings, Agents: the switch that lets agents use the open project (the app link, off until turned on), and what the
// person allowed each agent, with Revoke. The hub keeps both. The agent bridge refuses the whole section: only a person
// turns the link on or asks an agent again.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Icon, Switch } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { appName } from '../edition'
import { liveBridge, type BridgeAppLink } from '../link/bridge'
import { set, toast, useApp } from '../state/store'

type Grant = Awaited<ReturnType<BridgeAppLink['grants']>>[number]

const RIGHTS: Record<'read' | 'edit', string> = { read: 'Can read the open project', edit: 'Can read and change the open project' }

export function AgentsSection() {
  const linkEpoch = useApp((s) => s.linkEpoch)
  const link = liveBridge()?.appLink
  const [on, setOn] = useState<boolean | null>(null)
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!link) return
    const [o, g] = await Promise.all([link.isOn(), link.grants()])
    setOn(o)
    setGrants(g.filter((x) => x.rights !== null || x.denied))
  }, [link])

  useEffect(() => {
    void load().catch(() => setOn(null))
  }, [load, linkEpoch])

  if (!link) {
    return (
      <section className="set-sec" aria-labelledby="agents-h" data-testid="agents-settings" data-agent-refuse>
        <h3 id="agents-h">Agents</h3>
        <p className="sx-small">
          Agents reach the open project through the printer bridge.{' '}
          <Button variant="ghost" size="sm" onClick={() => set({ settingsSection: 'bridge' })}>
            Connect the printer bridge
          </Button>
        </p>
      </section>
    )
  }

  const toggle = (v: boolean) =>
    void link.setOn(v).then(
      (now) => {
        setOn(now)
        toast(now ? 'Agents can ask to use the open project.' : 'Agents can no longer use the open project.', 'info')
      },
      (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'),
    )

  const revoke = async (g: Grant) => {
    setBusy(g.clientId)
    try {
      await link.revoke(g.clientId)
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="set-sec" aria-labelledby="agents-h" data-testid="agents-settings" data-agent-refuse>
      <h3 id="agents-h">Agents</h3>
      <p className="sx-small sx-muted">
        Agents you connected in Settings, {ASSISTANT_NAME}, Connect your AI agent can work on the project open in {appName()}: read the plate and change designs and objects, each change one step you
        can undo. {appName()} asks you before each agent's first use. Printing always stays with you.
      </p>
      <div className="watch-rows">
        <p className="app-experimental-row">
          <span>
            <b>Let agents use the open project</b>
            <br />
            <span className="sx-small sx-muted">Off: agents can still slice files and use their own projects, but not this window.</span>
          </span>
          <Switch id="agents-app-link" label="Let agents use the open project" testId="agents-app-link" checked={on === true} disabled={on === null} onChange={toggle} />
        </p>
      </div>
      <h4 className="set-sub">Allowed agents</h4>
      {grants === null ? null : grants.length ? (
        <ul className="dev-list" data-testid="agents-grants">
          {grants.map((g) => (
            <li key={g.clientId} data-testid={`agents-grant-${g.clientId}`}>
              <Icon name={g.denied ? 'close' : 'check'} />
              <span className="min0">
                <b>{g.name}</b>
                <small className="sx-muted">{g.denied ? 'Denied until the app restarts' : RIGHTS[g.rights!]}</small>
              </span>
              <Button size="sm" data-testid={`agents-revoke-${g.clientId}`} disabled={busy === g.clientId} onClick={() => void revoke(g)}>
                {g.denied ? 'Ask again' : 'Revoke'}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sx-small sx-muted" data-testid="agents-grants-empty">
          No agent has asked yet.
        </p>
      )}
    </section>
  )
}
