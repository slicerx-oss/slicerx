// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > mimir: the shared mimir setup, agents, mimir cloud's saved chats switch, and turning mimir off.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, SwitchRow } from '@slicerx/ui'
import { useState } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { pilotState, set, useApp } from '../state/store'
import { bridgeConnector } from '../link/connector'
import { AgentPanel } from './agent-panel'
import { useMimirCloudHost } from './cloud'
import { cloudReady } from './cloud-edition'
import { keyStoreFor } from './keys'
import { MimirSetup } from './mimir-setup'
import './connect.css'

type Forget = { step: 'idle' } | { step: 'confirm' } | { step: 'busy' } | { step: 'done'; note: string }

/** Settings > mimir: whether free mimir saves chats, and deleting the ones it saved. Only where the cloud runs. */
function CloudShare() {
  const edition = useEdition()
  const cloud = useMimirCloudHost()
  const share = useApp((s) => s.mimirShare)
  const [forget, setForget] = useState<Forget>({ step: 'idle' })
  if (!cloud || !cloudReady(edition, cloud)) return null
  const run = async () => {
    setForget({ step: 'busy' })
    try {
      const n = await cloud.forget()
      setForget({ step: 'done', note: n === 0 ? 'No chats were saved from this computer.' : `Deleted ${n} saved ${n === 1 ? 'chat' : 'chats'}.` })
    } catch (e) {
      setForget({ step: 'done', note: e instanceof Error ? e.message : String(e) })
    }
  }
  const asking = forget.step === 'confirm' || forget.step === 'busy'
  // every state sits in the same grid cell, so the row keeps the height of the tallest and nothing below moves
  return (
    <div className="pc-cloud-share">
      <SwitchRow
        id="mimir-share"
        testId="mimir-share"
        label={`Save my chats to improve ${ASSISTANT_NAME}`}
        detail="Turned off, nothing new is saved. Your own key or local model never saves anything."
        checked={share}
        onChange={(v) => set({ mimirShare: v })}
      />
      <div className="pc-forget">
        <div className="set-actions" data-on={forget.step === 'idle' || undefined} inert={forget.step !== 'idle' || undefined}>
          <Button variant="ghost" data-testid="danger-mimir-forget" onClick={() => setForget({ step: 'confirm' })}>
            Delete my saved chats
          </Button>
        </div>
        <div className="set-actions" role="alertdialog" aria-label="Confirm delete" data-on={asking || undefined} inert={!asking || undefined}>
          <span className="sx-small">Delete all saved chats? This can't be undone.</span>
          <Button variant="danger" data-testid="danger-mimir-forget-confirm" disabled={forget.step === 'busy'} onClick={() => void run()}>
            Delete
          </Button>
          <Button variant="ghost" disabled={forget.step === 'busy'} onClick={() => setForget({ step: 'idle' })}>
            Cancel
          </Button>
        </div>
        <div className="set-actions" data-on={forget.step === 'done' || undefined} inert={forget.step !== 'done' || undefined}>
          <span className="sx-small sx-muted" role="status">
            {forget.step === 'done' ? forget.note : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Settings > mimir: connect, or turn it off. */
export function PilotSettingsSection() {
  const host = useHost()
  const pref = useApp((s) => s.pilot)
  const on = pref === null || pref.mode === 'on'
  const off = useApp((s) => pilotState(s) === 'off')
  const bridgeOn = useApp((s) => s.bridgeStatus.state === 'on')
  return (
    <section className="set-sec" aria-labelledby="pilot-h">
      <h3 id="pilot-h">{ASSISTANT_NAME}</h3>
      <p className="sx-small sx-muted">{ASSISTANT_NAME} answers questions and suggests changes you approve. It uses a model you connect; nothing is sent while it is off.</p>
      <MimirSetup place="settings" idPrefix="pcs" />
      {/* an outside agent reaches mimir through a hub: the one the desktop app runs, or one this page is paired with */}
      {bridgeConnector()?.automatic === true || bridgeOn ? <AgentPanel idPrefix="pcs-ag" /> : null}
      <CloudShare />
      {off ? <p className="sx-small sx-muted">{ASSISTANT_NAME} is off. Connect above to turn it back on.</p> : null}
      {!off ? (
        <p className="set-actions">
          <Button
            variant="ghost"
            onClick={() => {
              const provider = pref?.provider
              if (provider && provider !== 'mimir-cloud') void keyStoreFor(host).delete(provider)
              set({ pilot: { mode: 'off' } })
            }}
          >
            {on ? `Turn ${ASSISTANT_NAME} off and forget the key` : `Turn ${ASSISTANT_NAME} off`}
          </Button>
        </p>
      ) : null}
    </section>
  )
}
