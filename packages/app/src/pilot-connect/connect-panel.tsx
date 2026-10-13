// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connect mimir: pick a provider, paste a key (or point at a local server), pick the model, test once, save.
// Used inside the shared mimir setup (mimir-setup.tsx). The key stays in an uncontrolled field until it is
// stored; it never enters React state, the app store or a log.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Field, Icon, Input, LinkButton, Select, SwitchRow } from '@slicerx/ui'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { chatGptFor, useChatGpt } from './chatgpt'
import { useMimirCloudHost } from './cloud'
import { cloudReady } from './cloud-edition'
import { LocalAiCard } from './local-ai-card'
import { detectRunners, useLocalAi } from './local-ai'
import { pilotState, set, useApp, type PilotPref } from '../state/store'
import { keyStoreFor, PROVIDERS, type PilotProvider } from './keys'
import { modelChoices, AUTO_MODEL } from './models'
import { hostLocalFetch, testConnection, type TestResult } from './transport'
import './connect.css'

// Anthropic before OpenAI: its Auto pairs Haiku with Sonnet, and it leads the bench
const ORDER: PilotProvider[] = ['mimir-cloud', 'anthropic', 'openai', 'local']

/** The host of a typed server address, or null when it is empty, unparseable or this computer. */
function remoteHost(address: string): string | null {
  const a = address.trim()
  if (!a) return null
  try {
    const h = new URL(a).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' ? null : h
  } catch {
    return null
  }
}

const OTHER = '\u0000other'

/** The saved model, with nothing saved read as Auto. */
const savedModel = (model: string | undefined): string => model?.trim() || AUTO_MODEL

/** The model, from a list with Auto first and a cost hint on each, or any other id typed under "Other model id". */
export function ModelPicker({ idPrefix, provider, value, onChange }: { idPrefix: string; provider: PilotProvider; value: string; onChange(id: string): void }) {
  const choices = modelChoices(provider)
  const listed = choices.some((c) => c.id === value)
  const [other, setOther] = useState(!listed)
  if (!choices.length)
    return (
      <Field htmlFor={`${idPrefix}-model`} label="Model" hint="As the server names it. Empty runs its default.">
        <Input id={`${idPrefix}-model`} data-testid="pc-model" mono value={value === AUTO_MODEL ? '' : value} placeholder={PROVIDERS[provider].defaultModel} onChange={(e) => onChange(e.target.value)} />
      </Field>
    )
  return (
    <>
      <Field htmlFor={`${idPrefix}-model`} label="Model">
        <Select
          id={`${idPrefix}-model`}
          data-testid="pc-model"
          value={other ? OTHER : value}
          onChange={(e) => {
            const v = e.target.value
            setOther(v === OTHER)
            if (v !== OTHER) onChange(v)
          }}
        >
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.cost ? `${c.label} (${c.cost})` : c.label}
            </option>
          ))}
          <option value={OTHER}>Other model id</option>
        </Select>
      </Field>
      {other ? (
        <Field htmlFor={`${idPrefix}-model-id`} label="Model id" hint={`Exactly as ${PROVIDERS[provider].label} names it.`}>
          <Input id={`${idPrefix}-model-id`} mono value={value} placeholder={PROVIDERS[provider].defaultModel} onChange={(e) => onChange(e.target.value)} />
        </Field>
      ) : null}
    </>
  )
}

export interface ConnectState {
  /** True once a test passed and the connection was saved. */
  connected: boolean
}

/**
 * `withLocal` false leaves out the local model tab, for a page that shows the local setup card on its own. `only` limits
 * the providers to these (the shared mimir setup passes the key providers, or the local one).
 */
export function ConnectPanel({ onConnected, idPrefix = 'pc', withLocal = true, only }: { onConnected?: () => void; idPrefix?: string; withLocal?: boolean; only?: readonly PilotProvider[] }) {
  const host = useHost()
  const pref = useApp((s) => s.pilot)
  const edition = useEdition()
  const withCloud = cloudReady(edition, useMimirCloudHost())
  const offered = ORDER.filter((id) => (withLocal || id !== 'local') && (withCloud || id !== 'mimir-cloud') && (!only || only.includes(id)))
  const [provider, setProvider] = useState<PilotProvider>(() => (pref?.provider && offered.includes(pref.provider) ? pref.provider : (offered[0] ?? 'openai')))
  const [baseUrl, setBaseUrl] = useState(pref?.baseUrl ?? '')
  const [model, setModel] = useState(pref?.provider === provider ? savedModel(pref?.model) : AUTO_MODEL)
  const [shown, setShown] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState(false)
  const localAi = edition.features.localAi
  // A server on another computer is the one case that needs an address typed in.
  const [manual, setManual] = useState(!localAi || Boolean(pref?.provider === 'local' && pref.baseUrl && !/^http:\/\/127\.0\.0\.1:(11434|1234)\//.test(pref.baseUrl)))
  const keyRef = useRef<HTMLInputElement>(null)
  const net = useLocalAi().net
  // Once the person has opened or closed the manual fields, detection no longer decides for them.
  const touched = useRef(false)
  const [hasLocalKey, setHasLocalKey] = useState(false)
  const info = PROVIDERS[provider]
  const store = keyStoreFor(host)
  const remote = provider === 'local' ? remoteHost(baseUrl) : null
  const saved = pref?.mode === 'on' && pref.provider === provider
  // The optional key of a model server on the network, asked for beside the address.
  const localKey = provider === 'local' && manual
  // Nothing running on this computer: the address fields are the way in, so show them.
  useEffect(() => {
    if (provider !== 'local' || !localAi) return
    let live = true
    void detectRunners(net).then(
      (found) => live && !touched.current && found.length === 0 && setManual(true),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [provider, localAi, net])
  useEffect(() => {
    if (provider === 'local') void store.has('local').then(setHasLocalKey, () => setHasLocalKey(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  const connect = async () => {
    setBusy(true)
    setResult(null)
    try {
      if (provider === 'mimir-cloud') {
        // no key and nothing to test: the install registers on the first question
        set({ pilot: { mode: 'on', provider: 'mimir-cloud' } })
        onConnected?.()
        return
      }
      const typed = keyRef.current?.value.trim() ?? ''
      const key = info.needsKey || localKey ? typed || (await store.get(provider)) : null
      const picked = savedModel(model)
      // the test call runs Auto as the provider default; the pref keeps Auto for mimir's routing
      const config = { provider, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(picked !== AUTO_MODEL ? { model: picked } : {}) }
      const viaHost = provider === 'local' ? chatGptFor(host)?.localModels : undefined
      const r = await testConnection(config, key, viaHost ? hostLocalFetch(viaHost) : undefined)
      setResult(r)
      if (!r.ok) return
      if ((info.needsKey || localKey) && typed) {
        await store.set(provider, typed)
        if (provider === 'local') setHasLocalKey(true)
      }
      if (keyRef.current) keyRef.current.value = ''
      const next: PilotPref = { mode: 'on', provider, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), model: picked }
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
      {offered.length > 1 ? (
      <div className="pc-providers" role="radiogroup" aria-label="Model provider" style={{ '--n': offered.length } as CSSProperties}>
        {offered.map((id) => {
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
                if (id !== provider) setModel(pref?.provider === id ? savedModel(pref.model) : AUTO_MODEL)
                setProvider(id)
                setResult(null)
              }}
            >
              <Icon name={id === 'local' ? 'desktop' : id === 'mimir-cloud' ? 'cloud' : 'key'} />
              <span>
                <b>{p.label}</b>
                <small>{id === 'local' ? 'A model you run yourself, on this computer or your network.' : id === 'mimir-cloud' ? p.where : `Your own ${p.label} API key. Calls go to ${p.label} only.`}</small>
              </span>
            </button>
          )
        })}
      </div>
      ) : null}
      {provider === 'mimir-cloud' ? (
        <div className="pc-act">
          <Button variant="primary" icon="link" onClick={() => void connect()} disabled={busy}>
            Use {info.label}
          </Button>
          {saved ? (
            <p className="pc-result ok" role="status">
              <Icon name="check" size={16} /> Connected to {info.label}.
            </p>
          ) : null}
        </div>
      ) : info.needsKey ? (
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
          <div className="pc-more" data-open={manual || !localAi ? true : undefined}>
            {localAi ? (
              <button
                type="button"
                className="pc-more-btn"
                aria-expanded={manual}
                aria-controls={`${idPrefix}-more`}
                onClick={() => {
                  touched.current = true
                  setManual(!manual)
                }}
              >
                <Icon name="server" size={20} />
                <span>Use a model server on another computer</span>
                <Icon name="chevron-down" size={18} />
              </button>
            ) : null}
            {manual ? (
              <div className="pc-more-body" id={`${idPrefix}-more`}>
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
              </div>
            ) : null}
          </div>
        </>
      )}
      {info.needsKey || manual ? (
        <ModelPicker key={provider} idPrefix={idPrefix} provider={provider} value={model} onChange={setModel} />
      ) : null}
      {info.needsKey || manual ? (
        <>
          <p className="pc-privacy">
            {provider === 'local'
              ? remote
                ? `Your questions and printer setup go only to the server at ${remote}.`
                : 'Nothing leaves this computer: your questions and the printer setup you entered go only to the local model.'
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
