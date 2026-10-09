// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The setup screen that asks what the plate tab opens in: Slicing or CAD design. Two large cards, each showing the same
// enclosure, solid with its fillets for CAD design and sliced into its toolpaths for Slicing, captured from the app's
// own viewport (open-art/). The answer is written when setup finishes and can be changed in Settings > Look and feel.
import { useRef, type KeyboardEvent } from 'react'
import { appName } from '../edition'
import { formatShortcut } from '../lib/keys'
import type { OpenIn } from './model'

const slicing = new URL('./open-art/slicing.webp', import.meta.url).href
const design = new URL('./open-art/design.webp', import.meta.url).href

const OPTIONS: readonly { id: OpenIn; name: string; sum: string; art: string }[] = [
  { id: 'slice', name: 'Slicing', sum: 'Start on the plate: printer, filament and settings, then slice.', art: slicing },
  { id: 'design', name: 'CAD model', sum: 'Start in Model: sketch, extrude and edit parts with their history.', art: design },
]

export function OpenStep({ choice, onChoose }: { choice: OpenIn; onChoose(c: OpenIn): void }) {
  const cards = useRef<(HTMLDivElement | null)[]>([])
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (step) {
      e.preventDefault()
      const j = (i + step + OPTIONS.length) % OPTIONS.length
      onChoose(OPTIONS[j]!.id)
      cards.current[j]?.focus()
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      onChoose(OPTIONS[i]!.id)
    }
  }
  return (
    <div className="fr-open">
      <header className="fr-head">
        <h1 className="fr-title fr-display">What do you want {appName()} to open in?</h1>
        <p className="fr-lede">Model and Slice are the first two tabs, and {formatShortcut('Mod+E')} switches. This sets where it starts; change it any time in Settings.</p>
      </header>
      <div className="fr-open-cards" role="radiogroup" aria-label="Open models in">
        {OPTIONS.map((o, i) => {
          const on = o.id === choice
          return (
            <div
              key={o.id}
              ref={(el) => {
                cards.current[i] = el
              }}
              role="radio"
              aria-checked={on}
              aria-label={o.name}
              aria-describedby={`fr-open-${o.id}`}
              tabIndex={on ? 0 : -1}
              className="fr-card fr-open-card"
              data-on={on ? true : undefined}
              onClick={() => onChoose(o.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <img className="fr-open-art" src={o.art} alt="" width={480} height={300} />
              <span className="fr-open-row">
                <span className="fr-card-main">
                  <span className="fr-card-name">{o.name}</span>
                  <span className="fr-card-sum" id={`fr-open-${o.id}`}>
                    {o.sum}
                  </span>
                </span>
                <span className="fr-radio" aria-hidden="true" />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
