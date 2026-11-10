// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One mimir setup, the same in first-run, Settings and the mimir panel, on desktop and in the browser: mimir cloud
// (free; in the browser for signed-in people only), a ChatGPT sign-in where the shell has one, your own key, a local
// model where this shell can run one, and in first-run Skip. The picked card opens its panel under the cards.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, Icon } from '@slicerx/ui'
import { lazy, Suspense, useRef, useState, type KeyboardEvent } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { set, useApp, type PilotPref } from '../state/store'
import { useChatGpt } from './chatgpt'
import { ChatGptCard } from './chatgpt-card'
import { useMimirCloudHost } from './cloud'
import { cloudOffer, mimirChoices, useLocalRuns, type MimirChoice } from './mimir-choices'
import { ConnectPanel } from './connect-panel'
import { PROVIDERS } from './keys'
import { LocalAiCard } from './local-ai-card'
import './connect.css'

const SignInForm = lazy(() => import('../features/store/signin').then((m) => ({ default: m.SignInForm })))

/** Where the setup shows: first-run (with Skip, and choices that apply on finish), Settings, or the mimir panel. */
export type MimirSetupPlace = 'setup' | 'settings' | 'panel'

export { cloudOffer, mimirChoices, type CloudOffer, type MimirChoice, type MimirOption } from './mimir-choices'

/** The card a saved connection belongs to, or null with none saved. */
export function choiceOf(pref: PilotPref | null, signIn: boolean): MimirChoice | null {
  if (pref?.mode !== 'on' || !pref.provider) return null
  if (pref.provider === 'mimir-cloud') return 'cloud'
  if (pref.provider === 'local') return 'local'
  return signIn && pref.provider === 'openai' && !pref.baseUrl ? 'chatgpt' : 'key'
}

/** What finishing first-run on a choice connects. mimir cloud has no key to test, so choosing it is the connect, as
 * Use mimir free is elsewhere; the other choices connect (or not) in their own panel. */
export function mimirOnFinish(choice: MimirChoice): { mode: 'on'; provider: 'mimir-cloud' } | null {
  return choice === 'cloud' ? { mode: 'on', provider: 'mimir-cloud' } : null
}

/** True when this shell can download and run a local model (a desktop shell registers one; a browser cannot). */

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
              During alpha we save free {ASSISTANT_NAME} chats for 30 days to improve it; you can turn this off there too.
            </p>
          ) : (
            <>
              <p className="sx-small sx-muted" data-testid="ms-cloud-saved">
                During alpha we save free {ASSISTANT_NAME} chats for 30 days to improve it.{' '}
                {place === 'settings' ? 'You can turn this off below.' : `You can turn this off in Settings, ${ASSISTANT_NAME}.`}
              </p>
              <div className="pc-act">
                {/* once on the cloud, the line says so; the button is only for switching to it */}
                {onCloud ? (
                  <p className="pc-result ok" role="status">
                    <Icon name="check" size={16} /> Connected to {PROVIDERS['mimir-cloud'].label}.
                  </p>
                ) : (
                  <Button variant="primary" icon="link" onClick={() => set({ pilot: { mode: 'on', provider: 'mimir-cloud' } })}>
                    Use {ASSISTANT_NAME} free
                  </Button>
                )}
              </div>
            </>
          )
        ) : null}
        {choice === 'cloud' && cloud === 'sign-in' ? (
          <div className="ms-signin" data-testid="ms-cloud-signin">
            <p className="sx-small sx-muted">Sign in or make a free account with your email. {ASSISTANT_NAME} works once you are signed in, right here.</p>
            <Suspense fallback={null}>
              <SignInForm compact />
            </Suspense>
          </div>
        ) : null}
        {choice === 'chatgpt' ? <ChatGptCard idPrefix={`${idPrefix}-cg`} withLocal={false} /> : null}
        {choice === 'key' ? <ConnectPanel idPrefix={`${idPrefix}-pc`} withLocal={false} only={['openai', 'anthropic']} /> : null}
        {choice === 'local' ? place === 'setup' ? <LocalAiCard background /> : <ConnectPanel idPrefix={`${idPrefix}-lc`} only={['local']} /> : null}
      </div>
    </div>
  )
}
