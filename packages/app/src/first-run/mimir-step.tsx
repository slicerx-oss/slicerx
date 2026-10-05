// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The optional last setup screen: connect mimir with a ChatGPT sign-in, an API key or a model on
// this computer, or skip. A local model downloads in the background; setup never waits for it.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Icon, type IconName } from '@slicerx/ui'
import { useRef, type KeyboardEvent } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { useChatGpt } from '../pilot-connect/chatgpt'
import { ChatGptCard } from '../pilot-connect/chatgpt-card'
import { ConnectPanel } from '../pilot-connect/connect-panel'
import { LocalAiCard } from '../pilot-connect/local-ai-card'

export type MimirChoice = 'chatgpt' | 'key' | 'local' | 'skip'

interface Option {
  id: MimirChoice
  icon: IconName
  name: string
  sum: string
}

/** The choices this build offers, in order: sign-in only where the shell can do it, local only when the edition keeps it. */
export function mimirChoices(opts: { signIn: boolean; localAi: boolean }): Option[] {
  const out: Option[] = []
  if (opts.signIn) out.push({ id: 'chatgpt', icon: 'cloud', name: 'Sign in with ChatGPT', sum: 'Answers with your ChatGPT plan. Nothing to paste.' })
  out.push({ id: 'key', icon: 'key', name: 'Use an API key', sum: 'Your own OpenAI or Anthropic key.' })
  if (opts.localAi) out.push({ id: 'local', icon: 'desktop', name: 'Run a local model', sum: 'Free and private. Downloads once, then works offline.' })
  out.push({ id: 'skip', icon: 'close', name: 'Skip for now', sum: 'Connect it later in Settings.' })
  return out
}

export function MimirStep({ choice, onChoose }: { choice: MimirChoice; onChoose(c: MimirChoice): void }) {
  const host = useHost()
  const signIn = useChatGpt(host) !== null
  const localAi = useEdition().features.localAi
  const options = mimirChoices({ signIn, localAi })
  const cards = useRef<(HTMLDivElement | null)[]>([])

  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (step) {
      e.preventDefault()
      const j = (i + step + options.length) % options.length
      const next = options[j]
      if (next) onChoose(next.id)
      cards.current[j]?.focus()
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      const o = options[i]
      if (o) onChoose(o.id)
    }
  }

  return (
    <div className="fr-mimir">
      <header className="fr-head">
        <h1 className="fr-title fr-display">Set up {ASSISTANT_NAME}</h1>
        <p className="fr-lede">{ASSISTANT_NAME} answers questions and suggests changes you approve. Optional; you can connect it later.</p>
      </header>
      <div className="fr-cards" role="radiogroup" aria-label={`How ${ASSISTANT_NAME} gets a model`}>
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
              aria-describedby={`fr-mimir-${o.id}`}
              tabIndex={on ? 0 : -1}
              className="fr-card"
              data-on={on ? true : undefined}
              onClick={() => onChoose(o.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="fr-card-ic" aria-hidden="true">
                <Icon name={o.icon} size={26} />
              </span>
              <span className="fr-card-main">
                <span className="fr-card-name">{o.name}</span>
                <span className="fr-card-sum" id={`fr-mimir-${o.id}`}>
                  {o.sum}
                </span>
              </span>
              <span className="fr-radio" aria-hidden="true" />
            </div>
          )
        })}
      </div>
      <div className="fr-mimir-detail">
        {choice === 'chatgpt' ? <ChatGptCard idPrefix="fr-cg" withLocal={false} /> : null}
        {choice === 'key' ? <ConnectPanel idPrefix="fr-pc" withLocal={false} /> : null}
        {choice === 'local' ? <LocalAiCard background /> : null}
      </div>
    </div>
  )
}
