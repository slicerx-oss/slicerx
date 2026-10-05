// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pieces every modeling tool panel shares: probe mode for the view, the panel frame and a number field.
import type { PickEvent } from '@slicerx/viewport'
import { Block, Field, Input, VectorField, type Axis } from '@slicerx/ui'
import { useEffect, useRef, type ReactNode } from 'react'
import { cameraBus, setProbeHandler, setTool, toolStore } from '../plate/tools'
import { set } from '../state/store'

export const num = (s: string) => Number(s.trim().replace(',', '.'))
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
    return () => {
      setProbeHandler(null)
      cameraBus()?.probeFaces?.(false)
      cameraBus()?.guides?.({})
      if (toolStore.getState().tool === 'probe') setTool(before === 'probe' ? 'move' : before)
    }
  }, [faces])
}

export function Num({ id, label, unit, value, onChange, onEnter }: { id: string; label: string; unit: string; value: string; onChange: (v: string) => void; onEnter?: () => void }) {
  return (
    <Field htmlFor={id} label={label}>
      <Input id={id} mono unit={unit} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} {...(onEnter ? { onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && onEnter() } : {})} />
    </Field>
  )
}

/** An X, Y (and Z) row in one outline, over the panel's text values. A drag on an axis letter edits it live. */
export function Vec({ id, label, ariaLabel, unit, axes, values, onChange }: { id: string; label: string; ariaLabel?: string; unit: string; axes: readonly Axis[]; values: readonly string[]; onChange: readonly ((v: string) => void)[] }) {
  const set = (i: number, v: number) => onChange[i]?.(String(v))
  return <VectorField id={id} label={label} {...(ariaLabel ? { ariaLabel } : {})} unit={unit} axes={axes} values={values.map((v) => (Number.isFinite(num(v)) ? num(v) : 0))} onCommit={set} onPreview={set} />
}

export function Shell({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  // The tool was picked from a menu further down the sidebar, so its panel is brought into view.
  useEffect(() => {
    document.querySelector('[data-section="cad-tool"]')?.scrollIntoView({ block: 'nearest' })
  }, [])
  return (
    <Block title={title} data-section="cad-tool" aside={aside} className="cad">
      {children}
    </Block>
  )
}
