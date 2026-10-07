// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A listing's filament colors: swatches in the Filament block's language (one
// per color, a ring on the colors that go through the AMS, the name on hover
// and focus) and a line that keeps total colors apart from multi-color parts,
// so "8 colors" never reads as an 8 color AMS print.
import type { ListingColors } from '@slicerx/contracts'
import { useId, useState } from 'react'
import { Icon, Switch, tipAttrs } from '@slicerx/ui'
import { Swatch } from '@slicerx/app'
import { COLOR_NAME_MAX, MAX_LISTING_COLORS } from '@slicerx/store/validate'
import { addColor, moveColor, removeColor, setPartAms, updateColor, type ColorDraft } from './colors-edit'

/** The colors any AMS part uses, by index. */
export function amsColors(c: ListingColors): Set<number> {
  return new Set(c.parts.filter((p) => p.ams).flatMap((p) => p.colors))
}

/**
 * The plain line under the swatches: "8 colors" or "Single color", then how many parts need the AMS,
 * or "one color per part" when several colors print as separate single-color parts.
 */
export function colorSummary(c: ListingColors): { colors: string; ams: string | null; perPart: boolean } {
  const n = c.colors.length
  const ams = c.parts.filter((p) => p.ams).length
  return {
    colors: n === 1 ? 'Single color' : `${n} colors`,
    ams: ams > 0 ? `${ams} ${ams === 1 ? 'part' : 'parts'} multi-color (AMS)` : null,
    perPart: ams === 0 && n > 1 && c.parts.length > 1,
  }
}

/** The line as one sentence, for screen readers: "8 colors, 2 parts multi-color (AMS)". */
export function colorSentence(c: ListingColors): string {
  const s = colorSummary(c)
  return s.ams ? `${s.colors}, ${s.ams}` : s.perPart ? `${s.colors}, one color per part` : s.colors
}

function colorTip(c: ListingColors, i: number, ams: boolean): { title: string; body: string } {
  const col = c.colors[i]!
  const parts = c.parts.filter((p) => p.ams && p.colors.includes(i)).map((p) => p.name)
  const where = ams ? `Through the AMS for ${parts.slice(0, 3).join(', ')}${parts.length > 3 ? ` and ${parts.length - 3} more` : ''}.` : 'Single-color parts only.'
  return { title: col.name ?? col.hex, body: col.name ? `${col.hex}. ${where}` : where }
}

/**
 * The swatches. `max` caps how many show, the rest count as "+3". `size` 'sm' is the card size.
 * Each swatch takes focus so its tip (name, hex, which parts) reads by keyboard as well.
 */
export function ColorDots({ colors, max, size, focusable = true }: { colors: ListingColors; max?: number; size?: 'sm'; focusable?: boolean }) {
  const ams = amsColors(colors)
  const shown = max !== undefined && colors.colors.length > max ? max : colors.colors.length
  const rest = colors.colors.length - shown
  return (
    <ul className="lc-dots" data-size={size} aria-label={colorSentence(colors)}>
      {colors.colors.slice(0, shown).map((col, i) => {
        const tip = colorTip(colors, i, ams.has(i))
        return (
          <li
            key={`${i}-${col.hex}`}
            className="lc-dot"
            data-ams={ams.has(i) ? '' : undefined}
            tabIndex={focusable ? 0 : undefined}
            aria-label={`${tip.title}${ams.has(i) ? ', through the AMS' : ''}`}
            {...(focusable ? tipAttrs(tip) : {})}
          >
            <Swatch color={col.hex} {...(size ? { size } : {})} />
          </li>
        )
      })}
      {rest > 0 ? (
        <li className="lc-more" aria-label={`${rest} more`}>
          +{rest}
        </li>
      ) : null}
    </ul>
  )
}

/** Swatches and the summary line, for the listing sheet and the featured design. */
export function ColorFacts({ colors, label = true }: { colors: ListingColors; label?: boolean }) {
  const s = colorSummary(colors)
  return (
    <div className="lc-facts">
      {label ? <span className="lc-label">Colors</span> : null}
      <ColorDots colors={colors} />
      <p className="lc-line">
        <span>{s.colors}</span>
        {s.ams ? (
          <>
            <span className="lc-sep" aria-hidden="true">
              ·
            </span>
            <span className="lc-ams">
              <i className="lc-key" aria-hidden="true" />
              {s.ams}
            </span>
          </>
        ) : s.perPart ? (
          <>
            <span className="lc-sep" aria-hidden="true">
              ·
            </span>
            <span>one color per part</span>
          </>
        ) : null}
      </p>
    </div>
  )
}

/**
 * The creator's colors editor, in the Upload form and the colors sheet: each color with its swatch (click to pick
 * another), a name, drag or arrow keys to reorder and a remove button; then each part with a switch for the AMS.
 */
export function ColorsEditor({ draft, onChange }: { draft: ColorDraft; onChange: (d: ColorDraft) => void }) {
  const ids = useId()
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const { colors, parts } = draft.colors
  const err = colors.length ? null : 'No colors yet. Add the colors the model prints in.'
  return (
    <div className="lc-edit">
      {colors.length ? (
        <ol className="lc-rows" aria-label="Colors, in the order they show">
          {colors.map((c, i) => (
            <li
              key={draft.keys[i]}
              className="lc-row"
              data-drag={dragFrom === i ? '' : undefined}
              onDragOver={(e) => {
                if (dragFrom !== null) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragFrom !== null) onChange(moveColor(draft, dragFrom, i))
                setDragFrom(null)
              }}
            >
              <button
                type="button"
                className="ce-grip"
                draggable
                aria-label={`Move color ${i + 1}. Use the up and down arrow keys.`}
                onDragStart={(e) => {
                  setDragFrom(i)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => setDragFrom(null)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault()
                    onChange(moveColor(draft, i, i + (e.key === 'ArrowUp' ? -1 : 1)))
                  }
                }}
              >
                <Icon name="more" size={14} />
              </button>
              <label className="lc-pick" data-ams={amsColors(draft.colors).has(i) ? '' : undefined}>
                <input type="color" className="sr-only" aria-label={`Color ${i + 1}, ${c.hex}`} value={c.hex} onChange={(e) => onChange(updateColor(draft, i, { hex: e.currentTarget.value }))} />
                <Swatch color={c.hex} />
              </label>
              <input
                className="ce-in"
                id={`${ids}-n${i}`}
                aria-label={`Color ${i + 1} name`}
                placeholder="Name, like Silk gold"
                maxLength={COLOR_NAME_MAX}
                value={c.name ?? ''}
                onChange={(e) => onChange(updateColor(draft, i, { name: e.currentTarget.value }))}
              />
              <span className="lc-hex">{c.hex}</span>
              <button type="button" className="ce-rm" aria-label={`Remove color ${i + 1}`} onClick={() => onChange(removeColor(draft, i))}>
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <span className="ce-hint">{err}</span>
      )}
      {colors.length < MAX_LISTING_COLORS ? (
        <div className="ce-ops">
          <button type="button" className="ce-file" onClick={() => onChange(addColor(draft))}>
            <Icon name="plus" size={14} /> Add color
          </button>
        </div>
      ) : null}
      {parts.length ? (
        <div className="lc-parts">
          <span className="lc-sub">
            Parts <span className="ce-hint">Switch on the parts that print in more than one color through the AMS.</span>
          </span>
          <ul className="lc-plist" aria-label="Parts">
            {parts.map((p, k) => (
              <li key={`${k}-${p.name}`} className="lc-prow">
                <label htmlFor={`${ids}-p${k}`} className="lc-pname">
                  {p.name}
                </label>
                <ColorDots colors={{ colors: p.colors.map((i) => colors[i]!).filter(Boolean), parts: [] }} size="sm" max={6} focusable={false} />
                <Switch id={`${ids}-p${k}`} checked={p.ams} tone="pink" onChange={(on) => onChange(setPartAms(draft, k, on))} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
