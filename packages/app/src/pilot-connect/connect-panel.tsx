// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connect mimir: pick a provider, paste a key (or point at a local server), test once, save.
// Used by first-run setup and by Settings. The key stays in an uncontrolled field until it is
// stored; it never enters React state, the app store or a log.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Field, Icon, Input, LinkButton } from '@slicerx/ui'
import { useEffect, useRef, useState } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { AgentPanel } from './agent-panel'
import { ChatGptCard } from './chatgpt-card'
import { chatGptFor, useChatGpt } from './chatgpt'
import { LocalAiCard } from './local-ai-card'
import { pilotState, set, useApp, type PilotPref } from '../state/store'
import { keyStoreFor, PROVIDERS, type PilotProvider } from './keys'
import { hostLocalFetch, testConnection, type TestResult } from './transport'
import './connect.css'

const ORDER: PilotProvider[] = ['openai', 'anthropic', 'local']

export interface ConnectState {
  /** True once a test passed and the connection was saved. */
  connected: boolean
}

/** `withLocal` false leaves out the local model tab, for a page that shows the local setup card on its own. */
export function ConnectPanel({ onConnected, idPrefix = 'pc', withLocal = true }: { onConnected?: () => void; idPrefix?: string; withLocal?: boolean }) {
  const host = useHost()
  const pref = useApp((s) => s.pilot)
  const [provider, setProvider] = useState<PilotProvider>(pref?.provider ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(pref?.baseUrl ?? '')
  const [model, setModel] = useState(pref?.model ?? '')
  const [shown, setShown] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState(false)
  const localAi = useEdition().features.localAi
  // A server on another computer is the one case that needs an address typed in.
  const [manual, setManual] = useState(!localAi || Boolean(pref?.provider === 'local' && pref.baseUrl && !/^http:\/\/127\.0\.0\.1:(11434|1234)\//.test(pref.baseUrl)))
  const keyRef = useRef<HTMLInputElement>(null)
  const [hasLocalKey, setHasLocalKey] = useState(false)
  const info = PROVIDERS[provider]
  const store = keyStoreFor(host)
  const saved = pref?.mode === 'on' && pref.provider === provider
  // The optional key of a model server on the network, asked for beside the address.
  const localKey = provider === 'local' && manual
  useEffect(() => {
    if (provider === 'local') void store.has('local').then(setHasLocalKey, () => setHasLocalKey(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  const connect = async () => {
    setBusy(true)
    setResult(null)
    try {
      const typed = keyRef.current?.value.trim() ?? ''
      const key = info.needsKey || localKey ? typed || (await store.get(provider)) : null
      const config = { provider, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}) }
      const viaHost = provider === 'local' ? chatGptFor(host)?.localModels : undefined
      const r = await testConnection(config, key, viaHost ? hostLocalFetch(viaHost) : undefined)
      setResult(r)
      if (!r.ok) return
      if ((info.needsKey || localKey) && typed) {
        await store.set(provider, typed)
        if (provider === 'local') setHasLocalKey(true)
      }
      if (keyRef.current) keyRef.current.value = ''
      const next: PilotPref = { mode: 'on', provider, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), ...(config.model ? { model: config.model } : {}) }
      set({ pilot: next })
      onConnected?.()
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pc">
      <div className="pc-providers" role="radiogroup" aria-label="Model provider">
        {ORDER.filter((id) => withLocal || id !== 'local').map((id) => {
          const p = PROVIDERS[id]
          const on = id === provider
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              className="pc-provider"
              data-on={on ? true : undefined}
              onClick={() => {
                setProvider(id)
                setResult(null)
              }}
            >
              <Icon name={id === 'local' ? 'desktop' : 'cloud'} />
              <span>
                <b>{p.label}</b>
                <small>{id === 'local' ? 'A model on this computer. No key, nothing leaves it.' : `Your own ${p.label} API key. Calls go to ${p.label} only.`}</small>
              </span>
            </button>
          )
        })}
      </div>
      {info.needsKey ? (
        <Field
          htmlFor={`${idPrefix}-key`}
          label="API key"
          hint={`${info.where} ${host.capabilities.secureStorage ? 'Stored in your system keychain.' : 'Stored encrypted in this browser.'}`}
          aside={
            <button type="button" className="fr-textbtn" aria-pressed={shown} aria-controls={`${idPrefix}-key`} onClick={() => setShown(!shown)}>
              {shown ? 'Hide' : 'Show'}
            </button>
          }
        >
          <input id={`${idPrefix}-key`} ref={keyRef} className="sx-input" data-mono="true" type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder={saved ? 'A key is stored. Paste a new one to replace it.' : info.keyHint} />
        </Field>
      ) : (
        <>
          <LocalAiCard />
          {localAi ? (
            <LinkButton icon="server" expanded={manual} aria-controls={`${idPrefix}-base`} onClick={() => setManual(!manual)}>
              Use a model server on another computer
            </LinkButton>
          ) : null}
          {manual ? (
            <>
              <Field htmlFor={`${idPrefix}-base`} label="Server address" hint={info.where}>
                <Input
                  id={`${idPrefix}-base`}
                  mono
                  value={baseUrl}
                  placeholder="http://192.168.1.50:8080/v1"
                  onChange={(e) => setBaseUrl(e.target.value)}
                  data-tip-title="Any server with an OpenAI-compatible API"
                  data-tip-body="llama.cpp (llama-server), LocalAI, vLLM, LiteLLM or Ollama, on this computer, your home network or your Tailscale network. Use http and include /v1. Other addresses are refused."
                />
              </Field>
              <Field
                htmlFor={`${idPrefix}-key`}
                label="API key (if your server needs one)"
                hint={host.capabilities.secureStorage ? 'Stored in your system keychain.' : 'Stored encrypted in this browser.'}
                aside={
                  <>
                    {hasLocalKey ? (
                      <button
                        type="button"
                        className="fr-textbtn"
                        onClick={() => {
                          void store.delete('local').then(() => setHasLocalKey(false))
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                    <button type="button" className="fr-textbtn" aria-pressed={shown} aria-controls={`${idPrefix}-key`} onClick={() => setShown(!shown)}>
                      {shown ? 'Hide' : 'Show'}
                    </button>
                  </>
                }
              >
                <input
                  id={`${idPrefix}-key`}
                  ref={keyRef}
                  className="sx-input"
                  data-mono="true"
                  type={shown ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={hasLocalKey ? 'A key is stored. Paste a new one to replace it.' : 'Leave empty if there is none'}
                  data-tip-title="Optional server key"
                  data-tip-body="For servers started with a key, such as llama-server --api-key, LiteLLM or a vLLM proxy. It is sent as an Authorization Bearer header to this server only. It is never put in the address, never logged and never saved with your preferences."
                />
              </Field>
            </>
          ) : null}
        </>
      )}
      {info.needsKey || manual ? (
        <Field htmlFor={`${idPrefix}-model`} label="Model (optional)" hint={`Leave empty for ${info.defaultModel}.`}>
          <Input id={`${idPrefix}-model`} mono value={model} placeholder={info.defaultModel} onChange={(e) => setModel(e.target.value)} />
        </Field>
      ) : null}
      {info.needsKey || manual ? (
        <>
          <p className="pc-privacy">
            {provider === 'local'
              ? 'Nothing leaves this computer: your questions and the printer setup you entered go only to the local model.'
              : `What leaves the browser: your questions and the printer setup you entered, sent to ${info.label} only. Access codes and printer keys are never sent.`}
          </p>
          <div className="pc-act">
            <Button variant="primary" icon="link" onClick={() => void connect()} disabled={busy}>
              {busy ? 'Testing' : 'Test and connect'}
            </Button>
            {result ? (
              <p className={result.ok ? 'pc-result ok' : 'pc-result bad'} role="status">
                <Icon name={result.ok ? 'check' : 'alert'} size={16} /> {result.message}
              </p>
            ) : saved ? (
              <p className="pc-result ok" role="status">
                <Icon name="check" size={16} /> Connected to {info.label}.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

/** Settings > mimir: connect, or turn it off. */
export function PilotSettingsSection() {
  const host = useHost()
  const gpt = useChatGpt(host)
  const pref = useApp((s) => s.pilot)
  const on = pref === null || pref.mode === 'on'
  const off = useApp((s) => pilotState(s) === 'off')
  return (
    <section className="set-sec" aria-labelledby="pilot-h">
      <h3 id="pilot-h">{ASSISTANT_NAME}</h3>
      <p className="sx-small sx-muted">{ASSISTANT_NAME} answers questions and suggests changes you approve. It uses a model you connect; nothing is sent while it is off.</p>
      <ChatGptCard idPrefix="pcs" withLocal={!gpt} />
      {gpt ? <LocalAiCard /> : null}
      <AgentPanel idPrefix="pcs-ag" />
      {off ? <p className="sx-small sx-muted">{ASSISTANT_NAME} is off. Connect above to turn it back on.</p> : null}
      {!off ? (
        <p className="set-actions">
          <Button
            variant="ghost"
            onClick={() => {
              const provider = pref?.provider
              if (provider) void keyStoreFor(host).delete(provider)
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
