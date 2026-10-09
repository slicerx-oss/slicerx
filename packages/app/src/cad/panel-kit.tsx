// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pieces every modeling tool panel shares: probe mode for the view, the panel frame and a number field.
import type { PickEvent } from '@slicerx/viewport'
import { Block, Button, Field, Input, VectorField, type Axis } from '@slicerx/ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { takePicks } from '../plate/sub-pick'
import { cameraBus, setProbeHandler, setTool, toolStore } from '../plate/tools'
import { set, useApp } from '../state/store'
import { stepName } from './history/model'
import { typedNumber } from './value-table'

/** A typed number: plain, or arithmetic over the project's named values (`wall * 2`). NaN when it does not read. */
export const num = (s: string) => typedNumber(s)
export const close = () => set({ objectTool: null })
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

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
  return m
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

/** A typed number for a tool: plain or an expression over named values, the unit once beside the label. */
export function Num({ id, label, unit, value, onChange, onEnter }: { id: string; label: string; unit: string; value: string; onChange: (v: string) => void; onEnter?: () => void }) {
  return (
    <Field
      htmlFor={id}
      label={
        <>
          {label} <span className="cad-num-unit">{unit}</span>
        </>
      }
    >
      <Input id={id} className="cad-num" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} {...(onEnter ? { onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), onEnter()) } : {})} />
    </Field>
  )
}

/** An X, Y (and Z) row in one outline, over the panel's text values. A drag on an axis letter edits it live, and a typed
 * value can use named values. */
export function Vec({ id, label, ariaLabel, unit, axes, values, onChange }: { id: string; label: string; ariaLabel?: string; unit: string; axes: readonly Axis[]; values: readonly string[]; onChange: readonly ((v: string) => void)[] }) {
  const set = (i: number, v: number) => onChange[i]?.(String(v))
  return <VectorField id={id} label={label} {...(ariaLabel ? { ariaLabel } : {})} unit={unit} axes={axes} values={values.map((v) => (Number.isFinite(num(v)) ? num(v) : 0))} parse={num} onCommit={set} onPreview={set} />
}

export function Shell({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  // The tool was picked from a menu further down the sidebar, so its panel is brought into view.
  useEffect(() => {
    document.querySelector('[data-section="cad-tool"]')?.scrollIntoView({ block: 'nearest' })
  }, [])
  // Editing a step, the header names where: the object, then the step.
  const crumb = useApp((s) => {
    const e = s.historyEdit
    const step = e && !e.view ? e.original.history?.steps[e.index] : undefined
    return e && step ? `${e.original.name} › ${stepName(step)}` : null
  })
  return (
    <Block title={title} data-section="cad-tool" aside={crumb ? <span data-testid="model-tool-crumb">{crumb}</span> : aside} className="cad">
      {children}
    </Block>
  )
}

/** A tool's apply: true when it went through, so Apply can close the tool. */
export type ApplyRun = () => unknown

export interface ToolFooterProps {
  /** The tool's verb for Apply: "Make hole", "Pull out", "Cut". */
  verb: string
  onApply: ApplyRun
  /** Apply can't run yet (nothing picked, a bad number). */
  disabled?: boolean
  busy?: boolean
  /** Hole, Fillet and Thread: "Apply and repeat" keeps the tool open with the same settings and an empty pick. */
  repeat?: boolean
  /** Buttons at the start of the row, such as Other plane. */
  extra?: ReactNode
}

/** Is the key for a control that uses Enter itself: a multi-line field, a button, a list. */
const ownsEnter = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SELECT' || t.isContentEditable || t.getAttribute('role') === 'combobox')

/**
 * The footer every modeling tool shares: Cancel (Esc) closes the tool, Apply (Enter) runs it and closes, and on the
 * tools made for runs of the same feature, Apply and repeat runs it and stays open for the next pick.
 */
export function ToolFooter({ verb, onApply, disabled = false, busy = false, repeat = false, extra }: ToolFooterProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [running, setRunning] = useState(false)
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
  return (
    <div ref={ref} className="cad-actions cad-footer">
      {extra}
      <Button variant="ghost" data-testid="model-tool-cancel" onClick={close} disabled={working} tip={{ title: 'Close the tool', key: 'Esc' }}>
        Cancel
      </Button>
      {repeat ? (
        <Button data-testid="model-tool-repeat" onClick={() => void go(true)} disabled={disabled || working} tip={{ title: 'Apply and pick the next one', body: 'The tool stays open with the same settings.' }}>
          Apply and repeat
        </Button>
      ) : null}
      <Button variant="primary" data-testid="model-tool-apply" onClick={() => void go(false)} disabled={disabled || working} tip={{ title: verb, key: 'Enter' }}>
        {working ? 'Working' : verb}
      </Button>
    </div>
  )
}
