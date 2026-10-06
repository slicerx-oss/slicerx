// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Pattern section of the shape tool and the sketch's extrude: none, a line (copies, spacing, direction on the
// face), a grid (columns and rows along the face), a circle (copies round a point of the face, over a sweep), or a
// pattern at points a step already has, kept whole until another mode is picked. Sizes take named values. pattern.ts
// reads the fields.
import { Seg } from '@slicerx/ui'
import { Num } from './panel-kit'
import { copyCount, type Pattern, type PatternFields } from './pattern'

const DEFAULTS: Record<Exclude<PatternFields['kind'], 'points'>, PatternFields> = {
  none: { kind: 'none' },
  line: { kind: 'line', count: '3', step: '10', angle: '0' },
  grid: { kind: 'grid', count: '3', step: '10', count2: '2', step2: '10' },
  circle: { kind: 'circle', count: '6', centerX: '0', centerY: '0', sweep: '360' },
}

/** The fields for a pattern a step already has; a points pattern is kept whole. */
export function fieldsOf(p: Pattern | undefined): PatternFields {
  if (!p) return DEFAULTS.none
  if (p.kind === 'points') return { kind: 'points', pattern: p }
  if (p.kind === 'circular') return { kind: 'circle', count: String(p.count), centerX: String(p.center[0]), centerY: String(p.center[1]), sweep: String(p.angleDeg ?? 360) }
  if (p.count2 !== undefined && p.step2Mm) return { kind: 'grid', count: String(p.count), step: String(Math.hypot(...p.stepMm)), count2: String(p.count2), step2: String(Math.hypot(...p.step2Mm)) }
  const angle = (Math.atan2(p.stepMm[1], p.stepMm[0]) * 180) / Math.PI
  return { kind: 'line', count: String(p.count), step: String(Math.hypot(...p.stepMm)), angle: String(Math.round(angle * 1e6) / 1e6) }
}

export function PatternSection({ value, onChange }: { value: PatternFields; onChange: (v: PatternFields) => void }) {
  const set = (k: string, v: string) => onChange({ ...value, [k]: v } as PatternFields)
  return (
    <>
      <div className="cad-row">
        <span>Pattern</span>
        <Seg
          label="Pattern"
          size="sm"
          value={value.kind}
          onChange={(k) => k !== 'points' && onChange(DEFAULTS[k])}
          options={[
            { value: 'none', label: 'None' },
            { value: 'line', label: 'Line' },
            { value: 'grid', label: 'Grid' },
            { value: 'circle', label: 'Circle' },
            ...(value.kind === 'points' ? [{ value: 'points' as const, label: 'Points' }] : []),
          ]}
        />
      </div>
      {value.kind === 'points' ? <p className="cad-hint">{`Points, ${copyCount(value.pattern)} copies (edit the points from the sketch)`}</p> : null}
      {value.kind === 'line' ? (
        <div className="cad-pair">
          <Num id="pat-count" label="Copies" unit="" value={value.count} onChange={(v) => set('count', v)} />
          <Num id="pat-step" label="Spacing" unit="mm" value={value.step} onChange={(v) => set('step', v)} />
          <Num id="pat-angle" label="Direction" unit="°" value={value.angle} onChange={(v) => set('angle', v)} />
        </div>
      ) : value.kind === 'grid' ? (
        <div className="cad-pair">
          <Num id="pat-count" label="Columns" unit="" value={value.count} onChange={(v) => set('count', v)} />
          <Num id="pat-step" label="Column spacing" unit="mm" value={value.step} onChange={(v) => set('step', v)} />
          <Num id="pat-count2" label="Rows" unit="" value={value.count2} onChange={(v) => set('count2', v)} />
          <Num id="pat-step2" label="Row spacing" unit="mm" value={value.step2} onChange={(v) => set('step2', v)} />
        </div>
      ) : value.kind === 'circle' ? (
        <div className="cad-pair">
          <Num id="pat-count" label="Copies" unit="" value={value.count} onChange={(v) => set('count', v)} />
          <Num id="pat-sweep" label="Over" unit="°" value={value.sweep} onChange={(v) => set('sweep', v)} />
          <Num id="pat-cx" label="Center X" unit="mm" value={value.centerX} onChange={(v) => set('centerX', v)} />
          <Num id="pat-cy" label="Center Y" unit="mm" value={value.centerY} onChange={(v) => set('centerY', v)} />
        </div>
      ) : null}
    </>
  )
}
