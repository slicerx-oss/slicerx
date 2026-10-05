// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Brim ears tool options (OrcaSlicer's brim ears gizmo, GLGizmoBrimEars.cpp): head diameter, max angle, detection
// radius, Auto-generate, and removing the selected ears or all of them. The viewport places, selects, drags and
// removes ears; this panel sets the options and counts them.
import { Block, Button, Field, Range } from '@slicerx/ui'
import { useMemo, useState } from 'react'
import { AUTO_DEFAULTS, autoGenerateEars, clearEars, detectionRange, HEAD_MAX, HEAD_MIN, headDiameter, removeSelectedEars, resizeSelectedEars, selectAllEars, setHeadDiameter, useHeadDiameter, useSelectedEars, worldEars } from '../../plate/brim-ears'
import { toast, useApp } from '../../state/store'

export function BrimEarsPanel() {
  const selected = useApp((s) => s.plate.find((p) => p.id === s.selection))
  const diameter = useHeadDiameter()
  const chosen = useSelectedEars(selected?.id)
  const [maxAngle, setMaxAngle] = useState<number>(AUTO_DEFAULTS.maxAngle)
  const [detection, setDetection] = useState<number>(AUTO_DEFAULTS.detection)
  const count = selected?.brimPoints?.length ?? 0
  const stray = selected ? worldEars(selected).filter((e) => e.error).length : 0
  // The slider's top end depends on the outline, so it is worked out once per object and placement.
  const detectionTop = useMemo(() => (selected ? detectionRange(selected.id) : 100), [selected?.id, selected?.transform]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Block title="Brim ears" data-section="brim-ears" aside={selected ? selected.name : 'Select an object'}>
      <p className="sx-small sx-muted">Click the model to add an ear under it. Click an ear to select it, drag to move it, right click to remove it. Shift and drag selects several.</p>
      <Field htmlFor="brim-head" label="Head diameter" aside={`${diameter.toFixed(1)} mm`}>
        <Range
          id="brim-head"
          min={HEAD_MIN}
          max={HEAD_MAX}
          step={0.5}
          value={diameter}
          onChange={(v) => {
            setHeadDiameter(v)
            if (selected) resizeSelectedEars(selected.id, headDiameter())
          }}
        />
      </Field>
      <Field htmlFor="brim-angle" label="Max angle" aside={`${maxAngle.toFixed(0)} deg`}>
        <Range id="brim-angle" min={0} max={180} step={1} value={maxAngle} onChange={setMaxAngle} />
      </Field>
      <Field htmlFor="brim-detect" label="Detection radius" aside={`${detection.toFixed(1)} mm`}>
        <Range id="brim-detect" min={0} max={Math.max(1, Math.round(detectionTop))} step={0.5} value={Math.min(detection, detectionTop)} onChange={setDetection} />
      </Field>
      <Button
        size="sm"
        disabled={!selected}
        onClick={() => {
          if (!selected) return
          const n = autoGenerateEars(selected.id, { maxAngle, detection })
          toast(n ? `Added ${n} ${n === 1 ? 'ear' : 'ears'}.` : 'No new ears: every corner already has one, or the outline has none to mark.', 'info')
        }}
      >
        Auto-generate
      </Button>
      <p className="sx-small" data-testid="brim-ear-count">
        {count === 0 ? 'No ears yet.' : `${count} ${count === 1 ? 'ear' : 'ears'}${chosen.length ? `, ${chosen.length} selected` : ''}.`}
        {stray ? ` ${stray} ${stray === 1 ? 'does' : 'do'} not touch the first layer and would print alone.` : ''}
      </p>
      <div className="sx-row">
        <Button size="sm" disabled={count === 0 || !selected} onClick={() => selected && selectAllEars(selected.id)}>
          Select all
        </Button>
        <Button size="sm" disabled={chosen.length === 0 || !selected} onClick={() => selected && removeSelectedEars(selected.id)}>
          Remove selected
        </Button>
        <Button size="sm" disabled={count === 0 || !selected} onClick={() => selected && clearEars(selected.id)}>
          Remove all
        </Button>
      </div>
    </Block>
  )
}
