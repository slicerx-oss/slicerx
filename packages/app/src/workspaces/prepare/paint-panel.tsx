// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The paint tool's options, shown in the sidebar while the tool is on: what to paint (filament color, seam,
// support or fuzzy skin), which brush, its size, and the filament to paint with (the slots from the Filament block).
// The viewport does the painting; this panel only sets its options.
import type { PaintSettings } from '@slicerx/viewport'
import { Block, Button, Field, Range, Seg, tipAttrs } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { useResolvedSlots } from '../../filament/use-slots'
import { clearPaint, hasPaint } from '../../plate/paint'
import { getPaintBus, subscribePaintBus } from '../../plate/tools'
import { Swatch } from '../../parts'
import { MoreButton, useMore } from '../../shell/more'
import { useApp } from '../../state/store'

const LAYERS = [
  { value: 'color', label: 'Color' },
  { value: 'seam', label: 'Seam' },
  { value: 'support', label: 'Support' },
  { value: 'fuzzy', label: 'Fuzzy skin' },
] as const

/** The brushes up front. Smart fill is Fill's edge angle, so it has no entry of its own. */
export const MAIN_BRUSHES = [
  { value: 'brush', label: 'Brush' },
  { value: 'fill', label: 'Fill' },
  { value: 'height', label: 'Height' },
] as const satisfies readonly { value: PaintSettings['tool']; label: string }[]

/** Behind More. */
export const MORE_BRUSHES = [
  { value: 'triangle', label: 'Triangle' },
  { value: 'gap', label: 'Gap fill' },
] as const satisfies readonly { value: PaintSettings['tool']; label: string }[]

function useBrush(): PaintSettings | undefined {
  const [s, setS] = useState<PaintSettings | undefined>(() => getPaintBus()?.get())
  useEffect(() => {
    setS(getPaintBus()?.get())
    return subscribePaintBus(() => setS(getPaintBus()?.get()))
  }, [])
  return s
}

export function PaintPanel() {
  const brush = useBrush()
  const slots = useResolvedSlots()
  const selected = useApp((s) => s.plate.find((p) => p.id === s.selection))
  const painted = hasPaint(selected?.paint)
  const more = useMore('paint')
  const bus = getPaintBus()
  if (!bus || !brush) return null
  const set = (p: Partial<PaintSettings>) => bus.set(p)
  const color = brush.layer === 'color'
  return (
    <Block title="Paint" data-section="paint" aside={<span className="fil-aside">{selected ? selected.name : 'Select an object'}<MoreButton id="paint" /></span>}>
      <Seg label="Paint layer" size="sm" value={brush.layer} options={LAYERS} onChange={(v) => set({ layer: v, state: 1 })} />
      {color ? (
        <div className="paint-slots" role="radiogroup" aria-label="Filament to paint with">
          {slots.map((s) => (
            <button key={s.index} type="button" role="radio" aria-label={`Filament ${s.index}`} aria-checked={brush.state === s.index && !brush.erase} className="paint-slot" {...tipAttrs({ title: `Filament ${s.index}`, body: s.type })} onClick={() => set({ state: s.index, erase: false })}>
              <Swatch color={s.color} />
              <span className="sx-mono">{s.index}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="sx-small sx-muted">{brush.layer === 'seam' ? 'Left button marks where the seam should go, right button where it must not.' : brush.layer === 'fuzzy' ? 'Left button adds fuzzy skin to the walls there, right button takes it off.' : 'Left button forces support, right button blocks it.'}</p>
      )}
      {/* An older smart fill choice reads as Fill. */}
      <Seg label="Brush" size="sm" value={(brush.tool === 'smart' ? 'fill' : brush.tool) as 'brush'} options={MAIN_BRUSHES} onChange={(v) => set({ tool: v })} />
      {more || MORE_BRUSHES.some((b) => b.value === brush.tool) ? <Seg label="More brushes" size="sm" value={brush.tool as 'triangle'} options={MORE_BRUSHES} onChange={(v) => set({ tool: v })} /> : null}
      {brush.tool === 'brush' ? (
        <>
          <Field htmlFor="paint-shape" label="Shape">
            <Seg label="Brush shape" size="sm" value={brush.shape} options={[{ value: 'sphere', label: 'Sphere' }, { value: 'circle', label: 'Circle' }]} onChange={(v) => set({ shape: v })} />
          </Field>
          <Field htmlFor="paint-radius" label="Size" aside={`${brush.radiusMm.toFixed(1)} mm`}>
            <Range id="paint-radius" min={0.4} max={8} step={0.2} value={brush.radiusMm} onChange={(v) => set({ radiusMm: v })} />
          </Field>
        </>
      ) : null}
      {brush.tool === 'height' ? (
        <Field htmlFor="paint-height" label="Band" aside={`${brush.heightMm.toFixed(1)} mm`}>
          <Range id="paint-height" min={0.1} max={30} step={0.1} value={brush.heightMm} onChange={(v) => set({ heightMm: v })} />
        </Field>
      ) : null}
      {brush.tool === 'smart' || brush.tool === 'fill' ? (
        <Field htmlFor="paint-angle" label="Edge angle" aside={`${Math.round(brush.tool === 'smart' ? brush.angleDeg : brush.fillAngleDeg)} deg`}>
          <Range id="paint-angle" min={0} max={90} step={1} value={Math.max(0, brush.tool === 'smart' ? brush.angleDeg : brush.fillAngleDeg)} onChange={(v) => set(brush.tool === 'smart' ? { angleDeg: v } : { fillAngleDeg: v })} />
        </Field>
      ) : null}
      <div className="paint-act">
        <Button size="sm" variant="ghost" pressed={brush.erase} onClick={() => set({ erase: !brush.erase })}>
          Erase
        </Button>
        <Button size="sm" variant="ghost" disabled={!painted || !selected} onClick={() => selected && clearPaint(selected.id, brush.layer)}>
          Clear {brush.layer}
        </Button>
      </div>
    </Block>
  )
}
