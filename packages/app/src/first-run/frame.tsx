// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pieces every setup screen shares: the footer with Back, Skip and the one primary action, and the
// help pane that follows the focused field.
import { Button, Icon, type IconName } from '@slicerx/ui'
import type { ReactNode } from 'react'
import type { HelpTopic } from './help-topics'

export interface FooterAction {
  label: string
  onClick: () => void
  disabled?: boolean
  icon?: IconName
  /** Why a disabled action cannot run yet, shown beside it and read with it. */
  hint?: string
  /** `info` for a prompt (nothing typed yet) rather than a problem. */
  hintTone?: 'info'
}

export function Footer({ back, skip, primary, secondary }: { back?: FooterAction | null; skip?: FooterAction | null; primary: FooterAction; secondary?: FooterAction | null }) {
  // A secondary action that cannot run yet is left out rather than shown gray on gray.
  const second = secondary && !secondary.disabled ? secondary : null
  return (
    <footer className="fr-foot">
      <div className="fr-foot-in">
        {back ? (
          <Button variant="ghost" icon="arrow-left" className="fr-back" data-testid="setup-back" onClick={back.onClick}>
            {back.label}
          </Button>
        ) : (
          <span className="fr-back" />
        )}
        {skip || second ? (
          <div className="fr-foot-links">
            {skip ? (
              <button type="button" className="fr-textbtn fr-skip" data-testid="setup-skip" onClick={skip.onClick}>
                {skip.label}
              </button>
            ) : null}
            {second ? (
              <Button variant="ghost" className="fr-second" data-testid="setup-secondary" onClick={second.onClick}>
                {second.label}
              </Button>
            ) : null}
          </div>
        ) : null}
        <span className="fr-foot-next">
          {primary.disabled && primary.hint ? (
            <span className="fr-foot-hint" id="fr-foot-hint" data-tone={primary.hintTone}>
              {primary.hint}
            </span>
          ) : null}
          <Button
            variant="primary"
            className="fr-primary fr-next-btn"
            data-testid="setup-next"
            iconEnd={primary.icon ?? 'arrow-right'}
            onClick={primary.onClick}
            disabled={primary.disabled}
            {...(primary.disabled && primary.hint ? { tip: primary.hint, 'aria-describedby': 'fr-foot-hint' } : {})}
          >
            {primary.label}
          </Button>
        </span>
      </div>
    </footer>
  )
}

/** Renders the tiny markdown the topics use: paragraphs and **bold**. */
export function TopicText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n+/).map((para, i) => (
        <p key={i}>
          {para.split(/(\*\*[^*]+\*\*)/g).map((part, j) => (part.startsWith('**') && part.endsWith('**') ? <b key={j}>{part.slice(2, -2)}</b> : part))}
        </p>
      ))}
    </>
  )
}

/** A nozzle with its size stamped on the flats, drawn in the icon language. */
function NozzleStamp() {
  return (
    <svg className="fr-help-img" viewBox="0 0 160 96" role="img" aria-label="The nozzle diameter is stamped on one of the hexagon flats">
      <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round">
        <path d="M44 18h72v10H44z" />
        <path d="M52 28h56l-6 30H58z" />
        <path d="M64 58h32l-10 22h-12z" />
        <path d="M80 80v8" />
      </g>
      <text x="80" y="47" textAnchor="middle" className="fr-help-stamp">
        0.4
      </text>
      <path d="M118 44h26" stroke="var(--cyan)" strokeWidth="1.5" />
      <text x="146" y="48" className="fr-help-cap">
        mm
      </text>
    </svg>
  )
}

export function HelpPane({ topic, extra, id = 'fr-help' }: { topic: HelpTopic; extra?: ReactNode; id?: string }) {
  return (
    <aside className="fr-help" aria-labelledby={`${id}-h`}>
      <div className="fr-help-in" key={topic.id} data-topic={topic.id}>
        <p className="fr-eyebrow">
          <Icon name="help" size={14} /> Help
        </p>
        <h3 id={`${id}-h`}>{topic.title}</h3>
        {topic.image === 'nozzle-stamp' ? <NozzleStamp /> : null}
        <TopicText text={topic.body} />
        {topic.steps ? (
          <ol className="fr-help-steps">
            {topic.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        ) : null}
        {extra}
      </div>
    </aside>
  )
}
