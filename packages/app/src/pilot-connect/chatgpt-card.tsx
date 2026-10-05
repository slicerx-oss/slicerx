// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connect your ChatGPT account: the default way mimir gets a model on the desktop. Sign-in opens the
// browser; usage counts against the person's ChatGPT plan. "Use an API key instead" opens the
// provider panel as the fallback. The browser build has no sign-in host and shows the key panel only.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Chip, Icon, LinkButton, Pill } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { useHost } from '../host'
import { set, useApp } from '../state/store'
import { useChatGpt, type ChatGptAccount } from './chatgpt'
import { ConnectPanel } from './connect-panel'
import './connect.css'

type State = { status: 'loading' } | { status: 'out' } | { status: 'in'; account: ChatGptAccount } | { status: 'connecting' } | { status: 'error'; message: string }

function whenText(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** The account card. `compact` is the dock's version: one line and a button. */
export function ChatGptCard({ compact = false, idPrefix = 'cg', withLocal = true }: { compact?: boolean; idPrefix?: string; withLocal?: boolean }) {
  const host = useHost()
  const gpt = useChatGpt(host)
  const pref = useApp((s) => s.pilot)
  const [state, setState] = useState<State>({ status: 'loading' })
  const [keyOpen, setKeyOpen] = useState(false)

  useEffect(() => {
    if (!gpt) return
    let live = true
    gpt.account().then(
      (a) => live && setState(a ? { status: 'in', account: a } : { status: 'out' }),
      (e: unknown) => live && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, [gpt])

  if (!gpt) {
    // No sign-in here (the browser): the key panel is the whole story.
    return compact ? null : <ConnectPanel idPrefix={idPrefix} withLocal={withLocal} />
  }

  const connect = async () => {
    setState({ status: 'connecting' })
    try {
      const account = await gpt.connect()
      setState({ status: 'in', account })
      // The plan route is the model connection: provider openai, the model the probe saw.
      set({ pilot: { mode: 'on', provider: 'openai', ...(account.capabilities?.model ? { model: account.capabilities.model } : {}) } })
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }
  const disconnect = async () => {
    try {
      await gpt.disconnect()
    } finally {
      setState({ status: 'out' })
      // Signed out is not turned off: mimir goes back to the connect step.
      if (pref?.provider === 'openai') set({ pilot: { mode: 'unset' } })
    }
  }

  const signedIn = state.status === 'in' ? state.account : null
  if (compact) {
    if (signedIn || state.status === 'loading') return null
    return (
      <div className="cg cg-compact">
        <Icon name="cloud" size={16} />
        <span className="min0">
          <b>Connect your ChatGPT account</b>
          <small>{ASSISTANT_NAME} answers with your plan. Nothing to paste.</small>
        </span>
        <Button size="sm" variant="primary" disabled={state.status === 'connecting'} onClick={() => void connect()}>
          {state.status === 'connecting' ? 'Waiting for the browser' : 'Connect'}
        </Button>
      </div>
    )
  }

  return (
    <div className="cg">
      <div className="cg-head">
        <Icon name="cloud" size={18} />
        <div className="min0">
          <b>ChatGPT account</b>
          <small>{signedIn ? `Signed in${signedIn.email ? ` as ${signedIn.email}` : ''}${signedIn.connectedAt ? `, since ${whenText(signedIn.connectedAt)}` : ''}.` : `Sign in once and ${ASSISTANT_NAME} answers with your plan. The browser opens for the sign-in; no key to paste.`}</small>
        </div>
        {signedIn ? <Pill state={signedIn.planUsage ? 'ok' : 'warn'}>{signedIn.planUsage ? 'Plan usage on' : 'Sign-in only'}</Pill> : null}
      </div>
      {signedIn ? (
        <>
          <dl className="cg-facts">
            <div>
              <dt>Model</dt>
              <dd className="sx-mono">{signedIn.capabilities?.model ?? 'picked on first use'}</dd>
            </div>
            <div>
              <dt>Can do</dt>
              <dd>
                {signedIn.capabilities ? (
                  <>
                    {signedIn.capabilities.text ? <Chip tone="green">Text</Chip> : null}
                    {signedIn.capabilities.tools ? <Chip tone="green">Tools</Chip> : null}
                    {signedIn.capabilities.images ? <Chip tone="green">Camera frames</Chip> : <Chip tone="orange">No images</Chip>}
                  </>
                ) : (
                  'Checked on first use'
                )}
              </dd>
            </div>
          </dl>
          {!signedIn.planUsage ? <p className="cg-note">The sign-in did not grant plan usage, so {ASSISTANT_NAME} cannot answer with it yet. Connect again and allow it, or use an API key.</p> : null}
          <div className="cg-act">
            <Button variant="ghost" icon="unlink" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <div className="cg-act">
          <Button variant="primary" icon="link" disabled={state.status === 'connecting' || state.status === 'loading'} onClick={() => void connect()}>
            {state.status === 'connecting' ? 'Waiting for the browser' : 'Connect'}
          </Button>
          {state.status === 'connecting' ? <span className="sx-small sx-muted">Finish the sign-in in the browser, then come back here.</span> : null}
        </div>
      )}
      {state.status === 'error' ? (
        <p className="pc-result bad" role="alert">
          <Icon name="alert" size={16} /> {state.message}
        </p>
      ) : null}
      <p className="cg-note">Usage counts against your ChatGPT plan. Weekly caps are set in ChatGPT&apos;s settings, not here. What leaves this computer: your questions and the printer setup you entered. Access codes and printer keys are never sent.</p>
      <div className="cg-key">
        <LinkButton icon="key" expanded={keyOpen} aria-controls={`${idPrefix}-key-panel`} onClick={() => setKeyOpen(!keyOpen)}>
          Use an API key instead
        </LinkButton>
        {keyOpen ? (
          <div id={`${idPrefix}-key-panel`} className="cg-key-panel">
            <ConnectPanel idPrefix={idPrefix} withLocal={withLocal} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
