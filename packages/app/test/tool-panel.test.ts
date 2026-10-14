// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pieces every tool panel shares: choices that fall back to icons or a select instead of running past the edge,
// messages as sentences without the tool's name in front, the action row with the primary on the right and Apply and
// repeat in its menu, and cards that keep their header while muted.
import { createElement, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Actions, Card, Choice, Message, Shell, ToolFooter } from '../src/cad/panel-kit'
import { choiceFit, choiceMeasure, GLYPH_WIDTH, selectFits, sentence } from '../src/cad/tool-panel'
import { get, set } from '../src/state/store'

const roots: Root[] = []

afterEach(() => {
  for (const r of roots.splice(0)) flushSync(() => r.unmount())
  document.body.innerHTML = ''
  set({ objectTool: null })
})

function render(el: ReactElement): HTMLElement {
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  roots.push(root)
  flushSync(() => root.render(el))
  return box
}

const click = (el: Element | null) => flushSync(() => (el as HTMLElement).click())

describe('how choices fit', () => {
  const short = { labels: [24, 30, 28], words: [24, 30, 28], icons: false }

  it('puts a few short options on one line', () => {
    expect(choiceFit({ ...short, width: 276 })).toBe('line')
  })

  it('never shows more than three options as words: icons when each has one, else a select', () => {
    const four = { labels: [20, 20, 20, 20], words: [20, 20, 20, 20], width: 600 }
    expect(choiceFit({ ...four, icons: false })).toBe('select')
    expect(choiceFit({ ...four, icons: true })).toBe('icons')
    // before layout too, so the first frame never shows a row of four
    expect(choiceFit({ ...four, width: 0, icons: false })).toBe('select')
  })

  it('wraps a long label onto two lines when its words fit, instead of cutting it', () => {
    // 276 px across three: about 89 px each, 71 px of text on one line
    expect(choiceFit({ labels: [30, 96, 40], words: [30, 52, 40], width: 276, icons: false })).toBe('wrap')
  })

  it('falls back when even two lines would cut a word', () => {
    expect(choiceFit({ labels: [30, 96, 40], words: [30, 96, 40], width: 276, icons: false })).toBe('select')
    expect(choiceFit({ labels: [30, 96, 40], words: [30, 96, 40], width: 276, icons: true })).toBe('icons')
  })

  it('keeps a three-way choice a segment with the narrow padding before falling back to a select', () => {
    // Direction in the 280 px pane: 215 px across three, about 68 px each; Symmetric is 58 px, one word
    const direction = { labels: [47.25, 57.875, 52.9375], words: [27.6, 57.875, 27.6], width: 215 }
    expect(choiceFit({ ...direction, icons: false })).toBe('tight')
    // icons still win when every option has one, and a set that fits the usual way is unchanged
    expect(choiceFit({ ...direction, icons: true })).toBe('icons')
    expect(choiceFit({ ...direction, width: 312 - 64, icons: false })).toBe('line')
    // a label too long even for the narrow padding is still a select
    expect(choiceFit({ labels: [30, 64, 40], words: [30, 64, 40], width: 215, icons: false })).toBe('select')
  })

  it('takes a narrower panel into account', () => {
    expect(choiceFit({ ...short, width: 160 })).toBe('line')
    expect(choiceFit({ ...short, width: 120 })).not.toBe('line')
  })

  it('puts a select in the 96 px control column only when its longest option fits there', () => {
    // "Through" in the select's face, with its padding and arrow
    expect(selectFits(52)).toBe(true)
    expect(selectFits(58)).toBe(true)
    expect(selectFits(59)).toBe(false)
  })

  it('counts a glyph with its label and with the word it sits before', () => {
    const width = (t: string) => t.length * 7
    const plain = choiceMeasure(['Two words', 'One'], [false, false], width)
    const glyphed = choiceMeasure(['Two words', 'One'], [true, false], width)
    expect(glyphed.labels).toEqual([plain.labels[0]! + GLYPH_WIDTH, plain.labels[1]])
    // the first word carries the glyph, so a short first word can become the longest
    expect(plain.words[0]).toBe(5 * 7)
    expect(glyphed.words[0]).toBe(3 * 7 + GLYPH_WIDTH)
    expect(glyphed.words[1]).toBe(plain.words[1])
    // a glyph can tip a set that just fits on one line over to two
    const fit = (m: { labels: number[]; words: number[] }) => choiceFit({ ...m, width: 200, icons: false })
    expect(fit(choiceMeasure(['Abcdefghijk', 'Ab'], [false, false], width))).toBe('line')
    expect(fit(choiceMeasure(['Abcdefghijk', 'Ab'], [true, false], width))).not.toBe('line')
  })
})

describe('messages', () => {
  it('reads as a sentence with no tool name in front', () => {
    expect(sentence('hole: pick the wall of a round hole that starts at a flat face')).toBe('Pick the wall of a round hole that starts at a flat face.')
    expect(sentence('Error: shell: the wall is thicker than the part')).toBe('The wall is thicker than the part.')
    expect(sentence('geom.fillet: radius too large')).toBe('Radius too large.')
  })

  it('leaves a sentence alone, including one with a colon of its own', () => {
    expect(sentence('Pick the font again: Arial is not loaded.')).toBe('Pick the font again: Arial is not loaded.')
    expect(sentence('That face is curved. Pick a flat face.')).toBe('That face is curved. Pick a flat face.')
    expect(sentence('  Type a number, such as 5 or -3.  ')).toBe('Type a number, such as 5 or -3.')
    expect(sentence('')).toBe('')
  })

  it('shows in the panel message style', () => {
    const el = render(createElement(Message, { text: 'hole: pick the wall of a round hole' }))
    const p = el.querySelector('.tp-msg')!
    expect(p.getAttribute('role')).toBe('status')
    expect(p.getAttribute('data-tone')).toBe('warn')
    expect(p.textContent?.trim()).toBe('Pick the wall of a round hole.')
    const err = render(createElement(Message, { text: 'it failed', tone: 'error' }))
    expect(err.querySelector('.tp-msg')?.getAttribute('data-tone')).toBe('error')
  })
})

describe('choices in a panel', () => {
  const change = vi.fn()
  const opts = (n: number, icons = false) =>
    [
      { value: 'a', label: 'Screw passes', icon: 'cut' as const },
      { value: 'b', label: 'Screw threads in', icon: 'move' as const },
      { value: 'c', label: 'Insert', icon: 'rotate' as const },
      { value: 'd', label: 'Size', icon: 'scale' as const },
    ]
      .slice(0, n)
      .map((o) => (icons ? o : { value: o.value, label: o.label }))

  it('shows three options as a segment under the label', () => {
    const el = render(createElement(Choice, { id: 't3', label: 'Head', value: 'a', onChange: change, options: opts(3) }))
    const row = el.querySelector('.tp-choice')!
    expect(row.getAttribute('data-fit')).toBe('line')
    expect(row.hasAttribute('data-wide')).toBe(true)
    expect(row.querySelector('.tp-label')?.textContent).toBe('Head')
    expect(row.querySelectorAll('[role="radio"]')).toHaveLength(3)
    expect(row.querySelector('select')).toBeNull()
  })

  it('turns four options into a select with the same name and value', () => {
    const el = render(createElement(Choice, { id: 't4', label: 'Hole for', ariaLabel: 'What the hole is for', value: 'b', onChange: change, options: opts(4) }))
    const select = el.querySelector('select')!
    expect(el.querySelector('.tp-choice')?.getAttribute('data-fit')).toBe('select')
    expect(select.getAttribute('aria-label')).toBe('What the hole is for')
    expect(select.value).toBe('b')
    expect([...select.options].map((o) => o.textContent)).toEqual(['Screw passes', 'Screw threads in', 'Insert', 'Size'])
    expect(el.querySelectorAll('[role="radio"]')).toHaveLength(0)
  })

  it('turns four options with icons into icon segments, each named by its label', () => {
    const el = render(createElement(Choice, { id: 't4i', label: 'Kind', value: 'a', onChange: change, options: opts(4, true) }))
    const radios = [...el.querySelectorAll('[role="radio"]')]
    expect(el.querySelector('.tp-choice')?.getAttribute('data-fit')).toBe('icons')
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Screw passes', 'Screw threads in', 'Insert', 'Size'])
    expect(radios.every((r) => r.querySelector('.sx-ic'))).toBe(true)
  })

  it('draws a glyph before the word while the words show', () => {
    const el = render(createElement(Choice, { id: 'tg', label: 'Finish', value: 'a', onChange: change, options: [{ value: 'a', label: 'Extrude', glyph: 'move' as const }, { value: 'b', label: 'Revolve' }] }))
    const [first, second] = [...el.querySelectorAll('[role="radio"]')]
    expect(el.querySelector('.tp-choice')?.getAttribute('data-fit')).toBe('line')
    expect(first?.querySelector('.sx-ic')).not.toBeNull()
    expect(first?.textContent).toContain('Extrude')
    expect(second?.querySelector('.sx-ic')).toBeNull()
  })

  it('a bare choice has no label line', () => {
    const el = render(createElement(Choice, { id: 'tb', label: 'Edge shape', bare: true, value: 'a', onChange: change, options: opts(2) }))
    expect(el.querySelector('.tp-label')).toBeNull()
    expect(el.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Edge shape')
  })
})

describe('the action row', () => {
  it('puts Cancel on the left as a quiet button and the primary on the right', () => {
    const el = render(createElement(ToolFooter, { verb: 'Make hole', onApply: () => true }))
    const start = el.querySelector('.tp-actions-start')!
    const end = el.querySelector('.tp-actions-end')!
    expect(start.querySelector('[data-testid="model-tool-cancel"]')?.getAttribute('data-variant')).toBe('ghost')
    expect(end.querySelector('[data-testid="model-tool-apply"]')?.getAttribute('data-variant')).toBe('primary')
    expect(el.querySelector('[data-testid="model-tool-more"]')).toBeNull()
    expect(el.querySelector('.tp-actions-extra')).toBeNull()
  })

  it('keeps Apply and repeat in a menu on the primary', async () => {
    set({ objectTool: 'holefit' })
    const apply = vi.fn(() => true)
    const el = render(createElement(ToolFooter, { verb: 'Make hole', onApply: apply, repeat: true }))
    expect(el.querySelector('.tp-actions-end .sx-split [data-testid="model-tool-apply"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="model-tool-repeat"]')).toBeNull()
    click(el.querySelector('[data-testid="model-tool-more"]'))
    const repeat = document.querySelector('[data-testid="model-tool-repeat"]')
    expect(repeat?.textContent).toBe('Apply and repeat')
    click(repeat)
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    // the tool stays open for the next pick
    expect(get().objectTool).toBe('holefit')
  })

  it('puts other actions on their own line above, never squeezed beside Cancel', () => {
    const el = render(createElement(ToolFooter, { verb: 'Extrude', onApply: () => true, extra: createElement('button', { type: 'button' }, 'Other plane') }))
    const rows = [...el.querySelector('.tp-actions')!.children].map((c) => c.className)
    expect(rows).toEqual(['tp-actions-extra', 'tp-actions-main'])
    expect(el.querySelector('.tp-actions-extra')?.textContent).toBe('Other plane')
  })

  it('keeps the primary one width whatever its verb says', () => {
    const el = render(createElement(ToolFooter, { verb: 'Round', verbs: ['Round', 'Bevel'], onApply: () => true }))
    const button = el.querySelector('[data-testid="model-tool-apply"]')!
    expect(button.textContent).toBe('Round')
    const sizers = [...button.querySelectorAll('.tp-steady-sizer')].map((s) => s.getAttribute('data-sizer'))
    expect(sizers.sort()).toEqual(['Bevel', 'Working'])
  })

  it('a panel without a tool footer gets the same row', () => {
    const el = render(createElement(Actions, { quiet: createElement('button', { type: 'button' }, 'Clear') }, createElement('button', { type: 'button' }, 'Done')))
    expect(el.querySelector('.tp-actions-start')?.textContent).toBe('Clear')
    expect(el.querySelector('.tp-actions-end')?.textContent).toBe('Done')
  })
})

describe('the panel header', () => {
  // the panel brings itself into view, which the test document can't do
  Element.prototype.scrollIntoView ??= () => {}

  it('puts the tool action after its state', () => {
    const action = createElement('button', { type: 'button', 'data-testid': 'act' }, 'Other plane')
    const el = render(createElement(Shell, { title: 'Sketch', aside: 'A face of Box', action, children: createElement('p', null, 'body') }))
    const aside = el.querySelector('.sx-block-h .sx-block-aside')!
    expect([...aside.children].map((c) => c.className)).toEqual(['tp-state', 'tp-head-action'])
    expect(aside.querySelector('[data-testid="model-tool-state"]')?.textContent).toBe('A face of Box')
    expect(aside.querySelector('.tp-head-action [data-testid="act"]')?.textContent).toBe('Other plane')
  })

  it('has no action slot when the tool has none', () => {
    const el = render(createElement(Shell, { title: 'Hole', aside: 'No hole yet', children: createElement('p', null, 'body') }))
    expect(el.querySelector('.tp-head-action')).toBeNull()
  })
})

describe('cards', () => {
  it('a muted card keeps its header and says why in one line', () => {
    const el = render(createElement(Card, { title: 'Solid', state: 'Waiting', muted: true, reason: 'close the profile to make a solid' }, createElement('p', null, 'fields')))
    const card = el.querySelector('.tp-card')!
    expect(card.hasAttribute('data-muted')).toBe(true)
    expect(card.querySelector('h4')?.textContent).toBe('Solid')
    expect(card.querySelector('.tp-card-state')?.textContent).toBe('Waiting')
    expect(card.querySelector('.tp-card-reason')?.textContent).toBe('Close the profile to make a solid.')
    expect(card.querySelector('.tp-card-body')).toBeNull()
  })

  it('an open card shows its body under the same header', () => {
    const el = render(createElement(Card, { title: 'Solid' }, createElement('p', null, 'fields')))
    expect(el.querySelector('.tp-card-body')?.textContent).toBe('fields')
    expect(el.querySelector('.tp-card-reason')).toBeNull()
  })
})
