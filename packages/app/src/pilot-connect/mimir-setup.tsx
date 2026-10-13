// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One mimir setup, the same in first-run, Settings and the mimir panel, on desktop and in the browser: mimir cloud
// (free; in the browser for signed-in people only), a ChatGPT sign-in where the shell has one, your own key, a local
// model where this shell can run one, and in first-run Skip. The picked card opens its panel under the cards.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Icon, type IconName } from '@slicerx/ui'
import { lazy, Suspense, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { set, useApp, type PilotPref } from '../state/store'
import { useChatGpt } from './chatgpt'
import { ChatGptCard } from './chatgpt-card'
import { useMimirCloudHost, type MimirCloudHost } from './cloud'
import { cloudOffered, cloudReady } from './cloud-edition'
import { ConnectPanel } from './connect-panel'
import { PROVIDERS } from './keys'
import { LocalAiCard } from './local-ai-card'
import { onLocalAiChange, registeredLocalAi } from './local-ai-host'
import type { EditionConfig } from '@slicerx/edition-config'
import './connect.css'

const SignInDialog = lazy(() => import('../features/store/signin').then((m) => ({ default: m.SignInDialog })))

export type MimirChoice = 'cloud' | 'chatgpt' | 'key' | 'local' | 'skip'
/** Where the setup shows: first-run (with Skip, and choices that apply on finish), Settings, or the mimir panel. */
export type MimirSetupPlace = 'setup' | 'settings' | 'panel'
/** mimir cloud here: ready to use, offered once the person signs in (the browser), or not offered. */
export type CloudOffer = 'ready' | 'sign-in' | 'none'

export interface MimirOption {
  id: MimirChoice
  icon: IconName
  name: string
  sum: string
}

/** Whether this build offers mimir cloud: the edition has it and the shell carries its host; a host that needs a
 * signed-in person (the browser) offers it as a sign-in until then. */
export function cloudOffer(edition: EditionConfig, h: MimirCloudHost | null): CloudOffer {
  if (!cloudOffered(edition, h)) return 'none'
  return cloudReady(edition, h) ? 'ready' : 'sign-in'
}

/**
 * The choices, in order: mimir cloud where offered, sign-in only where the shell can do it, your own key, local only
 * where the edition keeps it and the shell can run one (a browser cannot download or start a model), Skip in first-run.
 */
export function mimirChoices(opts: { cloud?: CloudOffer; signIn: boolean; localAi: boolean; skip?: boolean }): MimirOption[] {
  const out: MimirOption[] = []
  if (opts.cloud === 'ready') out.push({ id: 'cloud', icon: 'cloud', name: `${ASSISTANT_NAME} cloud, free daily`, sum: PROVIDERS['mimir-cloud'].where })
  if (opts.cloud === 'sign-in') out.push({ id: 'cloud', icon: 'cloud', name: `Sign in to use ${ASSISTANT_NAME} free`, sum: `Free daily use with your ${ASSISTANT_NAME} account. No key.` })
  if (opts.signIn) out.push({ id: 'chatgpt', icon: 'creator', name: 'Sign in with ChatGPT', sum: 'Answers with your ChatGPT plan. Nothing to paste.' })
  out.push({ id: 'key', icon: 'key', name: 'Use your own API key', sum: 'An OpenAI or Anthropic key. You pick the model.' })
  if (opts.localAi) out.push({ id: 'local', icon: 'desktop', name: 'Run a local model', sum: 'Free and private. Downloads once, then works offline.' })
  if (opts.skip ?? true) out.push({ id: 'skip', icon: 'close', name: 'Skip for now', sum: 'Connect it later in Settings.' })
  return out
}

/** The card a saved connection belongs to, or null with none saved. */
export function choiceOf(pref: PilotPref | null, signIn: boolean): MimirChoice | null {
  if (pref?.mode !== 'on' || !pref.provider) return null
  if (pref.provider === 'mimir-cloud') return 'cloud'
  if (pref.provider === 'local') return 'local'
  return signIn && pref.provider === 'openai' && !pref.baseUrl ? 'chatgpt' : 'key'
}

/** What finishing first-run on a choice connects. mimir cloud has no key to test, so choosing it is the connect, as
 * Use mimir cloud is elsewhere; the other choices connect (or not) in their own panel. */
export function mimirOnFinish(choice: MimirChoice): { mode: 'on'; provider: 'mimir-cloud' } | null {
  return choice === 'cloud' ? { mode: 'on', provider: 'mimir-cloud' } : null
}

/** True when this shell can download and run a local model (a desktop shell registers one; a browser cannot). */
function useLocalRuns(): boolean {
  const edition = useEdition()
  const f = useSyncExternalStore(onLocalAiChange, registeredLocalAi, () => null)
  return edition.features.localAi && f !== null
}

/**
 * The setup. First-run controls the choice (`choice`, `onChoose`) so finishing can apply it; Settings and the panel
 * keep their own, starting on the saved connection.
 */
export function MimirSetup({ place, choice: controlled, onChoose, idPrefix = 'ms' }: { place: MimirSetupPlace; choice?: MimirChoice; onChoose?: (c: MimirChoice) => void; idPrefix?: string }) {
  const host = useHost()
  const edition = useEdition()
  const signIn = useChatGpt(host) !== null
  const cloudHost = useMimirCloudHost()
  const cloud = cloudOffer(edition, cloudHost)
  const localAi = useLocalRuns()
  const pref = useApp((s) => s.pilot)
  const options = mimirChoices({ cloud, signIn, localAi, skip: place === 'setup' })
  const [own, setOwn] = useState<MimirChoice>(() => choiceOf(pref, signIn) ?? options[0]?.id ?? 'key')
  const choice = controlled ?? own
  const choose = (c: MimirChoice) => (onChoose ? onChoose(c) : setOwn(c))
  const cards = useRef<(HTMLDivElement | null)[]>([])
  const [signingIn, setSigningIn] = useState(false)
  const onCloud = pref?.mode === 'on' && pref.provider === 'mimir-cloud'

  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (step) {
      e.preventDefault()
      const j = (i + step + options.length) % options.length
      const next = options[j]
      if (next) choose(next.id)
      cards.current[j]?.focus()
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      const o = options[i]
      if (o) choose(o.id)
    }
  }

  return (
    <div className="ms" data-place={place}>
      {/* One way in (the browser without mimir cloud) needs no choice: its panel shows on its own. */}
      {options.length > 1 ? (
      <div className="ms-cards" role="radiogroup" aria-label={`How ${ASSISTANT_NAME} gets a model`}>
        {options.map((o, i) => {
          const on = o.id === choice
          return (
            <div
              key={o.id}
              ref={(el) => {
                cards.current[i] = el
              }}
              role="radio"
              aria-checked={on}
              aria-describedby={`${idPrefix}-${o.id}`}
              tabIndex={on ? 0 : -1}
              className="ms-card"
              data-on={on ? true : undefined}
              data-testid={`ms-choice-${o.id}`}
              onClick={() => choose(o.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="ms-card-ic" aria-hidden="true">
                <Icon name={o.icon} size={24} />
              </span>
              <span className="ms-card-main">
                <span className="ms-card-name">{o.name}</span>
                <span className="ms-card-sum" id={`${idPrefix}-${o.id}`}>
                  {o.sum}
                </span>
              </span>
              <span className="ms-radio" aria-hidden="true" />
            </div>
          )
        })}
      </div>
      ) : null}
      <div className="ms-detail">
        {choice === 'cloud' && cloud === 'ready' ? (
          place === 'setup' ? (
            <p className="sx-small sx-muted" data-testid="ms-cloud-note">
              No key to paste. {ASSISTANT_NAME} connects when you finish. To see today's use or switch to your own key, open Settings, {ASSISTANT_NAME}.
            </p>
          ) : (
            <div className="pc-act">
              <Button variant="primary" icon="link" onClick={() => set({ pilot: { mode: 'on', provider: 'mimir-cloud' } })}>
                Use {PROVIDERS['mimir-cloud'].label}
              </Button>
              {onCloud ? (
                <p className="pc-result ok" role="status">
                  <Icon name="check" size={16} /> Connected to {PROVIDERS['mimir-cloud'].label}.
                </p>
              ) : null}
            </div>
          )
        ) : null}
        {choice === 'cloud' && cloud === 'sign-in' ? (
          <div className="ms-signin">
            <Button variant="primary" data-testid="ms-cloud-signin" onClick={() => setSigningIn(true)}>
              Sign in
            </Button>
            <p className="sx-small sx-muted">Free with an account. You come back here, and {ASSISTANT_NAME} cloud is ready to pick.</p>
            {signingIn ? (
              <Suspense fallback={null}>
                <SignInDialog open onClose={() => setSigningIn(false)} />
              </Suspense>
            ) : null}
          </div>
        ) : null}
        {choice === 'chatgpt' ? <ChatGptCard idPrefix={`${idPrefix}-cg`} withLocal={false} /> : null}
        {choice === 'key' ? <ConnectPanel idPrefix={`${idPrefix}-pc`} withLocal={false} only={['openai', 'anthropic']} /> : null}
        {choice === 'local' ? place === 'setup' ? <LocalAiCard background /> : <ConnectPanel idPrefix={`${idPrefix}-lc`} only={['local']} /> : null}
      </div>
    </div>
  )
}
