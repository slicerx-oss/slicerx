// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connect your AI agent: pick the client, one "Add to <client>" button, one line on what happens,
// and the rule that stays true for every client: it can never start a print without your tap.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Icon } from '@slicerx/ui'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { AGENTS, agentMark, installAgent, needsRelay, useAgentInstall, type AgentId, type InstallResult } from './agents'
import './connect.css'
import { appName } from '../edition'

export function AgentPanel({ idPrefix = 'ag' }: { idPrefix?: string }) {
  const host = useAgentInstall()
  const [picked, setPicked] = useState<AgentId>('claude-desktop')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<InstallResult | null>(null)
  const [relay, setRelay] = useState(false)
  const agent = AGENTS.find((a) => a.id === picked) ?? AGENTS[0]!
  useEffect(() => {
    let live = true
    void host.relayReady?.().then((r) => live && setRelay(r))
    return () => {
      live = false
    }
  }, [host])
  useEffect(() => setResult(null), [picked])
  // Whether the picked agent already holds a credential here. Only a yes or no ever reaches the page.
  const [linked, setLinked] = useState(false)
  useEffect(() => {
    let live = true
    setLinked(false)
    void host.connected?.(picked).then((c) => live && setLinked(c), () => undefined)
    return () => {
      live = false
    }
  }, [host, picked])
  const blocked = needsRelay(agent.id) && !relay

  const add = async () => {
    setBusy(true)
    try {
      const r = await installAgent(host, agent.id)
      if (r.paste && !r.ok) await navigator.clipboard?.writeText(r.paste).catch(() => undefined)
      setResult(r)
      void host.connected?.(agent.id).then(setLinked, () => undefined)
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    try {
      await host.disconnect?.(agent.id)
      setLinked(false)
      setResult({ ok: true, message: `${agent.name} can no longer reach ${appName()} from this computer. Its credential was revoked and removed from your keychain.` })
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = AGENTS[(i + d + AGENTS.length) % AGENTS.length]!
    setPicked(next.id)
    document.getElementById(`${idPrefix}-${next.id}`)?.focus()
  }

  return (
    <div className="ag">
      <div className="ag-head">
        <b>Connect your AI agent</b>
        <small>Give the assistant you already use what {ASSISTANT_NAME} can do: watch your printers, slice and estimate, plan settings, queue jobs.</small>
      </div>
      <p className="ag-lbl" id={`${idPrefix}-lbl`}>
        Choose your agent
      </p>
      <div className="ag-pick" role="radiogroup" aria-labelledby={`${idPrefix}-lbl`}>
        {AGENTS.map((a, i) => {
          const on = a.id === picked
          return (
            <button key={a.id} id={`${idPrefix}-${a.id}`} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className="ag-tile" data-on={on ? true : undefined} onClick={() => setPicked(a.id)} onKeyDown={(e) => onKey(e, i)}>
              <span className="ag-mark" aria-hidden="true">
                {a.mark ? (agentMark(a.mark, 26, a.name) ?? <Icon name="terminal" size={26} />) : <Icon name={needsRelay(a.id) ? 'cloud' : 'terminal'} size={26} />}
              </span>
              <span className="ag-name">{a.name}</span>
            </button>
          )
        })}
      </div>
      <div className="ag-act">
        <Button variant="primary" icon="plus" disabled={busy || blocked} onClick={() => void add()}>
          {busy ? 'Working' : linked ? `Add to ${agent.name} again` : `Add to ${agent.name}`}
        </Button>
        {linked && host.disconnect ? (
          <Button variant="ghost" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        ) : null}
        <span className="ag-what">{blocked ? `Available once the camera relay is set up. Hosted assistants reach ${appName()} through it, not through this computer.` : agent.what}</span>
      </div>
      {linked && !result ? (
        <p className="ag-linked" role="status">
          <Icon name="check" size={15} /> Connected on this computer. Its credential is in your keychain and is never shown.
        </p>
      ) : null}
      {result ? (
        <div className={result.ok ? 'ag-result ok' : 'ag-result bad'} role="status">
          <p>
            <Icon name={result.ok ? 'check' : 'alert'} size={16} /> {result.message}
          </p>
          {result.paste ? (
            <>
              {result.pasteInto ? <p className="ag-into">{result.ok ? 'Also as an entry for' : 'The entry for'} <span className="sx-mono">{result.pasteInto}</span></p> : null}
              <pre className="ag-paste sx-mono">{result.paste}</pre>
            </>
          ) : null}
        </div>
      ) : null}
      <p className="ag-rule">
        <Icon name="shield" size={15} /> The agent can watch, slice and queue. It never starts a print without your tap.{' '}
        <button
          type="button"
          className="fra-more"
          data-tip-title="What the agent cannot do"
          data-tip-body={`It can never start a print, resume one or send G-code without your tap in ${appName()} or on your phone.`}
        >
          Details
        </button>
      </p>
    </div>
  )
}
