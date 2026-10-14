// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pieces every tool panel in the right sidebar shares, so Hole, Push and pull, Fillet, Shell, Thread, Cut, Array,
// Measure, Sketch and the rest read as one: the panel frame with the tool's state in its header, the hint line with
// the mouse glyph, cards for a tool's phases, one grid of rows (the label on the left, the control at the right edge, a
// number's unit beside its label, the settings rows' sizes), choices that never run past the edge, messages as
// sentences, and the action row with the primary action on the right. Probe mode for the view lives here too.
import type { PickEvent } from '@slicerx/viewport'
import { Block, Button, Icon, Input, Menu, MenuItem, Seg, Select, SplitButton, VectorField, type Axis, type IconName, type SegOption, type TipSpec } from '@slicerx/ui'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { takePicks } from '../plate/sub-pick'
import { cameraBus, setProbeHandler, setTool, toolStore } from '../plate/tools'
import { set, useApp } from '../state/store'
import { stepName } from '@slicerx/cad-history'
import { currentValues, typedNumber } from './value-table'
import { fromMmText, lengthText, toMmText } from './units'
import { useLength } from './use-units'
import { usePhoneLayout } from '../lib/phone-layout'
import { touchWords } from './touch-words'
import { choiceFit, selectFits, sentence, type ChoiceFit } from './tool-panel'
import './cad.css'

/** A typed number: plain, or arithmetic over the project's named values (`wall * 2`). NaN when it does not read. */
export const num = (s: string) => typedNumber(s)
export const close = () => set({ objectTool: null })
/** An error in the panel's words: a sentence, without the engine's tool-name prefix. */
export const errorText = (e: unknown) => sentence(e instanceof Error ? e.message : String(e))

/**
 * What went wrong with a face pick, in a sentence for the panel: a curved face, a face with no area,
 * a part that changed under the pointer, a damaged mesh, or the engine's own words. Null for a pick a
 * newer one replaced.
 */
export function pickWords(e: unknown, bedToo = false): string | null {
  if ((e as { name?: string } | null)?.name === 'AbortError') return null
  const m = e instanceof Error ? e.message : String(e)
  if (m.includes('pick a flat face')) return bedToo ? 'That face is curved. Pick a flat face, or the bed.' : 'That face is curved. Pick a flat face.'
  if (m.includes('no area')) return 'That face has no area to work on. Pick a larger face.'
  if (m.startsWith('triangle:')) return 'The part changed under the pointer. Pick the face again.'
  if (m.startsWith('mesh ')) return 'This part has a damaged mesh, so its faces cannot be picked. Repair it first.'
  return sentence(m)
}

/** Puts the view in probe mode while a tool is open and hands it the clicks. The earlier tool and a clean view come back on close. */
export function useProbe(onPick: (hit: PickEvent) => void, faces: boolean): void {
  const handler = useRef(onPick)
  handler.current = onPick
  useEffect(() => {
    const before = toolStore.getState().tool
    setTool('probe')
    cameraBus()?.probeFaces?.(faces)
    setProbeHandler((hit) => handler.current(hit))
    // Faces or edges picked before the tool opened are its first clicks, the later ones with Shift so they add.
    takePicks(faces).forEach((p, i) => handler.current({ objectId: p.objectId, partIndex: p.partIndex, triangle: p.triangle, point: p.point, bed: null, ...(i > 0 ? { shift: true } : {}) }))
    return () => {
      setProbeHandler(null)
      cameraBus()?.probeFaces?.(false)
      cameraBus()?.guides?.({})
      if (toolStore.getState().tool === 'probe') setTool(before === 'probe' ? 'move' : before)
    }
  }, [faces])
}

/** A quiet line of facts under the fields: what a pick or a size means. */
export function Note({ children, testId, status = false }: { children: ReactNode; testId?: string; status?: boolean }) {
  return (
    <p className="cad-hint tp-note" data-testid={testId} role={status ? 'status' : undefined}>
      <Icon name="info" size={15} /> <span>{children}</span>
    </p>
  )
}

/** A warning or an error in the panel's message style: a sentence, with no tool name in front of it. */
export function Message({ text, tone = 'warn', testId }: { text: string; tone?: 'warn' | 'error'; testId?: string }) {
  return (
    <p className="cad-note tp-msg" role="status" data-tone={tone} data-testid={testId}>
      <Icon name="alert" size={14} /> <span>{sentence(text)}</span>
    </p>
  )
}

export interface RowProps {
  label: ReactNode
  /** The unit, once, beside the label. */
  unit?: string | undefined
  /** The control's id, so the label names it. Without one the label is plain text with `labelId`. */
  htmlFor?: string
  labelId?: string
  /** The control takes the row under its label, from the label's edge to the right edge (choices, vectors, text). */
  wide?: boolean
  className?: string
  testId?: string
  children: ReactNode
}

/**
 * One row of a tool panel: the label on the left and the control ending at the panel's right edge, with the unit beside
 * the label. The sizes are the settings rows': a 40 px row, number fields 72 px, selects 132 px. A wide row puts the
 * control under the label instead.
 */
export function Row({ label, unit, htmlFor, labelId, wide = false, className, testId, children }: RowProps) {
  const text = (
    <>
      {label}
      {unit ? <> <span className="cad-num-unit">{unit}</span></> : null}
    </>
  )
  return (
    <div className={className ? `tp-row ${className}` : 'tp-row'} data-wide={wide ? '' : undefined} data-testid={testId}>
      {htmlFor ? (
        <label className="tp-label" htmlFor={htmlFor}>
          {text}
        </label>
      ) : (
        <span className="tp-label" id={labelId}>
          {text}
        </span>
      )}
      {children}
    </div>
  )
}

/** A typed number for a tool: plain or an expression over named values, the unit once beside the label. A length
 * (unit mm) shows in the display unit while `value` stays mm text (cad/units.ts). */
export function Num({ id, label, unit, value, onChange, onEnter }: { id: string; label: string; unit: string; value: string; onChange: (v: string) => void; onEnter?: () => void }) {
  const units = useApp((s) => s.units)
  const shown = unit === 'mm' && units.length !== 'mm'
  // what the person typed, kept while `value` is still what it gave
  const [draft, setDraft] = useState<{ text: string; gave: string } | null>(null)
  const text = !shown ? value : draft && draft.gave === value ? draft.text : fromMmText(value, units)
  const change = (t: string) => {
    if (!shown) return onChange(t)
    const gave = toMmText(t, units, currentValues())
    setDraft({ text: t, gave })
    onChange(gave)
  }
  return (
    <Row label={label} unit={shown ? units.length : unit} htmlFor={id}>
      <Input id={id} size="sm" className="cad-num tp-num" inputMode="decimal" value={text} onChange={(e) => change(e.target.value)} {...(onEnter ? { onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), onEnter()) } : {})} />
    </Row>
  )
}

/** An X, Y (and Z) row in one outline, over the panel's text values. A drag on an axis letter edits it live, and a typed
 * value can use named values. A length row shows in the display unit; the values stay mm. */
export function Vec({ id, label, ariaLabel, unit, axes, values, onChange }: { id: string; label: string; ariaLabel?: string; unit: string; axes: readonly Axis[]; values: readonly string[]; onChange: readonly ((v: string) => void)[] }) {
  const len = useLength()
  const length = unit === 'mm' && len.unit !== 'mm'
  const set = (i: number, v: number) => onChange[i]?.(String(length ? len.toMm(v) : v))
  const mm = values.map((v) => (Number.isFinite(num(v)) ? num(v) : 0))
  return <VectorField id={id} className="tp-vec" label={label} {...(ariaLabel ? { ariaLabel } : {})} unit={length ? len.unit : unit} axes={axes} values={length ? mm.map(len.show) : mm} parse={length ? len.parse : num} {...(length && len.digits !== undefined ? { digits: len.digits } : {})} onCommit={set} onPreview={set} />
}

export interface ChoiceOption<V extends string> {
  value: V
  label: string
  /** Shown alone, with the label as its tooltip, when the words don't fit. */
  icon?: IconName
  disabled?: boolean
  tip?: TipSpec
  testId?: string
}

export interface ChoiceProps<V extends string> {
  id: string
  /** The visible label over the choices; also their accessible name unless `ariaLabel` is given. */
  label: string
  ariaLabel?: string
  /** No visible label: the choices head the panel or a card, like a mode switch. */
  bare?: boolean
  value: V
  onChange: (value: V) => void
  options: readonly ChoiceOption<V>[]
}

/** A tool's line about what to pick in the view, one per panel under its header: mouse words on a desktop, a finger's words on a phone. */
export function PointerHint({ text }: { text: string }) {
  const phone = usePhoneLayout()
  const words = phone ? touchWords(text) : text
  // a line that only asked for a key leaves nothing for a finger
  if (!words) return null
  return (
    <p className="cad-hint tp-hint">
      <Icon name={phone ? 'info' : 'mouse-left'} size={15} /> {words}
    </p>
  )
}

/**
 * One of a few values, under its label across the panel's width, that never runs past the right edge: on one line
 * when every option fits, with a long label on two lines inside a segment of fixed height, and past three options or
 * when even two lines would cut a word, as icons with tooltips (when every option has one) or a select. Which one
 * depends only on the width and the words, never on the value, so pressing an option moves nothing.
 */
export function Choice<V extends string>({ id, label, ariaLabel, bare = false, value, onChange, options }: ChoiceProps<V>) {
  const box = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const icons = options.length > 0 && options.every((o) => o.icon)
  const [fit, setFit] = useState<ChoiceFit>(() => choiceFit({ labels: options.map(() => 0), words: options.map(() => 0), width: 0, icons }))
  // a select whose longest option fits the control column sits there, like a settings row's; a longer one goes under the label
  const [inline, setInline] = useState(true)
  const words = options.map((o) => o.label).join('\n')
  useLayoutEffect(() => {
    const el = box.current
    const p = probe.current
    if (!el || !p) return
    const width = (t: string, as: 'seg' | 'select' = 'seg') => {
      p.dataset['as'] = as
      p.textContent = t
      return p.getBoundingClientRect().width
    }
    const measure = () => {
      const labels = words.split('\n')
      setFit(choiceFit({ labels: labels.map((l) => width(l)), words: labels.map((l) => Math.max(0, ...l.split(/\s+/).map((w) => width(w)))), width: el.clientWidth, icons }))
      setInline(selectFits(Math.max(0, ...labels.map((l) => width(l, 'select')))))
    }
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    // the face's real widths arrive with the font
    void document.fonts?.ready.then(measure)
    return () => ro?.disconnect()
  }, [words, icons])
  const name = ariaLabel ?? label
  const segOptions = options.map((o): SegOption<V> => ({
    value: o.value,
    label: fit === 'icons' ? null : o.label,
    ...(fit === 'icons' && o.icon ? { icon: o.icon, title: o.label } : {}),
    ...(o.tip ? { tip: o.tip } : {}),
    ...(o.disabled ? { disabled: true } : {}),
    ...(o.testId ? { testId: o.testId } : {}),
  }))
  return (
    <div ref={box} className="tp-row tp-choice" data-wide={fit === 'select' && inline ? undefined : ''} data-fit={fit} data-bare={bare ? '' : undefined}>
      <span ref={probe} className="tp-seg-probe" aria-hidden="true" />
      {bare ? null : (
        <span className="tp-label" id={`${id}-label`}>
          {label}
        </span>
      )}
      {fit === 'select' ? (
        <Select id={id} size="sm" aria-label={name} value={value} onChange={(e) => onChange(e.target.value as V)}>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <Seg label={name} size="sm" full className={`tp-seg tp-seg-${fit}`} value={value} onChange={onChange} options={segOptions} />
      )}
    </div>
  )
}

/**
 * A phase of a tool, as a card with its own header: the sketch's drawing, then its solid. A card that can't be used yet
 * stays muted with one line saying why, and its header keeps its place, so opening it moves nothing above.
 */
export function Card({ title, state, muted = false, reason, testId, children }: { title: string; state?: ReactNode; muted?: boolean; reason?: string; testId?: string; children?: ReactNode }) {
  const body = muted ? (reason ? <p className="tp-card-reason">{sentence(reason)}</p> : null) : <div className="tp-card-body">{children}</div>
  return (
    <section className="tp-card" aria-label={title} data-muted={muted ? '' : undefined} data-testid={testId}>
      <div className="tp-card-h">
        <h4>{title}</h4>
        {state !== undefined ? <span className="tp-card-state">{state}</span> : null}
      </div>
      {body}
    </section>
  )
}

/**
 * The frame of a tool panel: its name, and its state on the right of the header ("No hole yet", "1 edge"). `section`
 * names it for the sidebar and the specs (the modeling tools are cad-tool, Cut is cut-tool).
 */
export function Shell({ title, aside, section = 'cad-tool', children }: { title: string; aside?: string; section?: string; children: ReactNode }) {
  // The tool was picked from a menu further down the sidebar, so its panel is brought into view.
  useEffect(() => {
    document.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [section])
  // Editing a step, the header names where: the object, then the step.
  const crumb = useApp((s) => {
    const e = s.historyEdit
    const step = e && !e.view ? e.original.history?.steps[e.index] : undefined
    return e && step ? `${e.original.name} › ${stepName(step, (mm) => lengthText(mm, s.units))}` : null
  })
  const state = crumb ?? aside
  return (
    <Block title={title} data-section={section} aside={state ? <ToolState text={state} crumb={crumb !== null} /> : undefined} className="cad tp">
      {children}
    </Block>
  )
}

/** The tool's state on the right of its header: "No hole yet", "1 edge", or the step being edited. */
export function ToolState({ text, crumb = false }: { text: string; crumb?: boolean }) {
  return (
    <span className="tp-state" data-testid={crumb ? 'model-tool-crumb' : 'model-tool-state'} data-tip-title={text}>
      {text}
    </span>
  )
}

/** A tool's apply: true when it went through, so Apply can close the tool. */
export type ApplyRun = () => unknown

/**
 * A button label that keeps the width of its widest form, so the button never changes size when the verb changes
 * with a choice ("Round" and "Bevel") or while it works.
 */
export function Steady({ text, forms }: { text: string; forms: readonly string[] }) {
  return (
    <span className="tp-steady">
      {[...new Set(forms)]
        .filter((f) => f !== text)
        .map((f) => (
          <span key={f} className="tp-steady-sizer" aria-hidden="true" data-sizer={f} />
        ))}
      <span>{text}</span>
    </span>
  )
}

/**
 * The action row every tool panel ends in: the quiet action (Cancel, Close, Clear) on the left, the primary on the
 * right, and anything else on its own line above them, so nothing is squeezed off the edge at the narrowest panel.
 */
export function Actions({ quiet, extra, children }: { quiet?: ReactNode; extra?: ReactNode; children?: ReactNode }) {
  return (
    <div className="cad-actions tp-actions">
      {extra ? <div className="tp-actions-extra">{extra}</div> : null}
      <div className="tp-actions-main">
        <span className="tp-actions-start">{quiet}</span>
        <span className="tp-actions-end">{children}</span>
      </div>
    </div>
  )
}

export interface ToolFooterProps {
  /** The tool's verb for Apply: "Make hole", "Pull out", "Cut". */
  verb: string
  /** Every verb Apply can show, so the button keeps one width as the verb changes. */
  verbs?: readonly string[]
  onApply: ApplyRun
  /** Apply can't run yet (nothing picked, a bad number). */
  disabled?: boolean
  busy?: boolean
  /** Hole, Fillet and Thread: "Apply and repeat", in the menu on Apply, keeps the tool open with the same settings and an empty pick. */
  repeat?: boolean
  /** Other actions, such as Other plane: on their own line above Cancel and Apply. */
  extra?: ReactNode
}

/** Is the key for a control that uses Enter itself: a multi-line field, a button, a list. */
const ownsEnter = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SELECT' || t.isContentEditable || t.getAttribute('role') === 'combobox')

/**
 * The footer every modeling tool shares: Cancel (Esc) closes the tool, Apply (Enter) runs it and closes, and on the
 * tools made for runs of the same feature, Apply and repeat (in the menu on Apply) runs it and stays open for the next
 * pick.
 */
export function ToolFooter({ verb, verbs = [], onApply, disabled = false, busy = false, repeat = false, extra }: ToolFooterProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [running, setRunning] = useState(false)
  const [menu, setMenu] = useState(false)
  const working = busy || running
  const go = async (stay: boolean) => {
    if (disabled || working) return
    setRunning(true)
    try {
      const ok = await onApply()
      if (ok && !stay) close()
    } finally {
      setRunning(false)
    }
  }
  const latest = useRef(go)
  latest.current = go
  useEffect(() => {
    const panel = ref.current?.closest('.sx-block.cad')
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return
      // A menu, a dialog or the command bar takes its own keys.
      if (document.querySelector('[role="menu"], [role="dialog"][aria-modal="true"]')) return
      // Esc from the tool, the view or nowhere in particular; the tree and the pill keep theirs.
      const t = e.target as Element | null
      const here = panel?.contains(t) || t === document.body || (t instanceof HTMLCanvasElement && t.classList.contains('vp-canvas'))
      const act = e.key === 'Escape' && here ? () => close() : e.key === 'Enter' && !e.shiftKey && panel?.contains(t) && !ownsEnter(t) ? () => void latest.current(false) : null
      // after every other listener: a sketch's line in progress, a field's own Enter or Esc, take the key first
      if (act) setTimeout(() => !e.defaultPrevented && act(), 0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // the panel fades out above the footer while there is more of it below
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = ref.current
    const scroller = el?.closest('.sx-rail-body')
    if (!el || !scroller) return
    const check = () => setMore(scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1)
    check()
    scroller.addEventListener('scroll', check, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check)
    ro?.observe(scroller)
    if (scroller.firstElementChild) ro?.observe(scroller.firstElementChild)
    return () => {
      scroller.removeEventListener('scroll', check)
      ro?.disconnect()
    }
  }, [])
  const label = <Steady text={working ? 'Working' : verb} forms={[verb, ...verbs, 'Working']} />
  const off = disabled || working
  const repeatItem = (
    <Menu open={menu} onClose={() => setMenu(false)} label="More ways to apply" align="end">
      <MenuItem
        data-testid="model-tool-repeat"
        data-tip-title="Apply and pick the next one"
        data-tip-body="The tool stays open with the same settings."
        onClick={() => {
          setMenu(false)
          void go(true)
        }}
      >
        Apply and repeat
      </MenuItem>
    </Menu>
  )
  return (
    <div ref={ref} className="cad-actions cad-footer tp-actions" {...(more ? { 'data-more': '' } : {})}>
      {extra ? <div className="tp-actions-extra">{extra}</div> : null}
      <div className="tp-actions-main">
        <span className="tp-actions-start">
          <Button variant="ghost" data-testid="model-tool-cancel" onClick={close} disabled={working} tip={{ title: 'Close the tool', key: 'Esc' }}>
            Cancel
          </Button>
        </span>
        <span className="tp-actions-end">
          {repeat ? (
            <SplitButton
              variant="primary"
              data-testid="model-tool-apply"
              onClick={() => void go(false)}
              disabled={off}
              tip={{ title: verb, key: 'Enter' }}
              menuLabel="More ways to apply"
              menuOpen={menu}
              onMenu={() => setMenu(!menu)}
              menuProps={{ 'data-testid': 'model-tool-more', disabled: off }}
              menu={repeatItem}
            >
              {label}
            </SplitButton>
          ) : (
            <Button variant="primary" data-testid="model-tool-apply" onClick={() => void go(false)} disabled={off} tip={{ title: verb, key: 'Enter' }}>
              {label}
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}
