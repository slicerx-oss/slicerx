// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch tool picker's two rows: the tool families as icons, and under them the ways to draw the picked family.
// The second row is always there at the same height, so nothing below it moves when the family changes. A family with
// one way to draw it (Select, Line, Dimension) shows its name there as a single picked segment that does nothing.
import { Icon, Seg, type SegOption } from '@slicerx/ui'
import type { DrawTool } from './sketch-model'

export type Family = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'polygon' | 'slot' | 'trim' | 'dimension'

/** The tool families, as icons; a family with ways to draw it shows them in the row below. */
export const FAMILIES: SegOption<Family>[] = [
  { value: 'select', label: '', icon: 'select-object', title: 'Select' },
  { value: 'line', label: '', icon: 'sk-line', title: 'Line', tip: { title: 'Line', key: 'L' } },
  { value: 'rect', label: '', icon: 'sk-rect', title: 'Rectangle', tip: { title: 'Rectangle', key: 'R' } },
  { value: 'circle', label: '', icon: 'sk-circle', title: 'Circle', tip: { title: 'Circle', key: 'C' } },
  { value: 'arc', label: '', icon: 'sk-arc', title: 'Arc' },
  { value: 'polygon', label: '', icon: 'sk-polygon', title: 'Polygon' },
  { value: 'slot', label: '', icon: 'sk-slot', title: 'Slot' },
  { value: 'trim', label: '', icon: 'cut', title: 'Trim', tip: { title: 'Trim', key: 'T' } },
  { value: 'dimension', label: '', icon: 'ruler', title: 'Dimension', tip: { title: 'Dimension', key: 'D' } },
]

export const VARIANTS: Partial<Record<Family, SegOption<DrawTool>[]>> = {
  rect: [{ value: 'rect', label: '2-point' }, { value: 'rect3', label: '3-point' }, { value: 'rectCenter', label: 'Center' }],
  circle: [{ value: 'circle', label: 'Center' }, { value: 'circle2', label: '2-point' }],
  arc: [{ value: 'arc', label: '3-point' }, { value: 'arcCenter', label: 'Center' }, { value: 'arcTangent', label: 'Tangent' }],
  polygon: [{ value: 'polygon', label: 'Inscribed' }, { value: 'polygonOut', label: 'Circumscribed' }, { value: 'polygonEdge', label: 'Edge' }],
  slot: [{ value: 'slot', label: 'Center to center' }, { value: 'slotOverall', label: 'Overall' }, { value: 'slotCenter', label: 'Center point' }],
  trim: [{ value: 'trim', label: 'Trim' }, { value: 'extend', label: 'Extend' }],
}

export const familyOf = (t: DrawTool): Family => (Object.entries(VARIANTS).find(([, v]) => v.some((o) => o.value === t))?.[0] as Family | undefined) ?? (t as Family)

/** The family's name, as its icon's tooltip says it. */
export const familyName = (f: Family): string => FAMILIES.find((o) => o.value === f)?.title ?? f

export interface SketchVariantsProps {
  tool: DrawTool
  onPick: (t: DrawTool) => void
  /** The polygon's side count, as typed. */
  sides: string
  onSides: (v: string) => void
  /** Keep the row with nothing in it: the phone bar, where the row also holds Finish sketch at its end. */
  reserve?: boolean
}

/**
 * The second row of the picker: the family's ways to draw. A family with one way has no row at all in the panel, so
 * it takes no room; picking a family with ways shows it below the tools. On the phone bar the row stays (`reserve`),
 * since Finish sketch sits at its end. The tool's name is in the Drawing card's header, and on a phone in the sheet's
 * summary just above the tool strip.
 */
export function SketchVariants({ tool, onPick, sides, onSides, reserve = false }: SketchVariantsProps) {
  const family = familyOf(tool)
  const ways = VARIANTS[family]
  if (!ways && family !== 'polygon' && !reserve) return null
  return (
    <div className="sketch-variants">
      {ways ? (
        <Seg label="Draw it by" size="sm" full={family !== 'polygon'} value={tool} onChange={onPick} options={ways} />
      ) : null}
      {family === 'polygon' ? (
        <label className="sketch-sides" data-tip-title="Sides" data-tip-body="How many sides the polygon has, 3 to 64.">
          <Icon name="sk-polygon" size={14} />
          <input id="sk-sides" className="sx-input" data-mono data-size="sm" inputMode="numeric" aria-label="Sides" value={sides} onChange={(e) => onSides(e.target.value)} />
        </label>
      ) : null}
    </div>
  )
}
