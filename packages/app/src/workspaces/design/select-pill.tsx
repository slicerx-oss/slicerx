// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's selection pill, at the top left of the view: what a click picks (objects, faces, edges), what is picked in
// plain words, and a way to clear it. The filter keys are Alt+1, Alt+2 and Alt+3, with Shift to add or drop a kind.
import { Icon, keymapFor, tipAttrs } from '@slicerx/ui'
import { useLookChoice } from '../../first-run/look'
import { PICK_KINDS, PICK_LABEL, pickReadout, type PickKind } from '../../plate/pick-filter'
import { setPickKind } from '../../plate/sub-pick'
import { set, useApp } from '../../state/store'

const ICON: Readonly<Record<PickKind, 'select-object' | 'select-face' | 'select-edge'>> = { object: 'select-object', face: 'select-face', edge: 'select-edge' }

export function SelectPill() {
  const filter = useApp((s) => s.pickFilter)
  const plate = useApp((s) => s.plate)
  const names: Record<string, string> = {}
  for (const p of plate) names[p.id] = p.name
  const selected = useApp((s) => s.selectedIds)
  const primary = useApp((s) => s.selection)
  const picks = useApp((s) => s.subPicks)
  const choice = useLookChoice()
  const map = keymapFor(choice.id, choice.overrides?.keys ?? {})
  const ids = primary ? [primary, ...selected.filter((id) => id !== primary)] : selected
  const objects = ids.map((id) => names[id]).filter((n): n is string => n !== undefined)
  const on = (kind: 'face' | 'edge') => picks.filter((p) => p.kind === kind).map((p) => ({ object: names[p.objectId] ?? 'an object' }))
  const readout = pickReadout({ objects, faces: on('face'), edges: on('edge') })
  const anything = objects.length > 0 || picks.length > 0
  return (
    <div className="select-pill sx-overlay" data-testid="model-select-pill" role="group" aria-label="Selection">
      <div className="select-pill-kinds" role="group" aria-label="Pick">
        {PICK_KINDS.map((k) => {
          const key = map[`select.${k}`]
          return (
            <button
              key={k}
              type="button"
              className="select-pill-kind"
              data-testid="model-select-filter"
              data-kind={k}
              aria-pressed={filter.includes(k)}
              aria-label={PICK_LABEL[k].label}
              {...tipAttrs({ title: PICK_LABEL[k].label, body: `${PICK_LABEL[k].tip}. Shift adds or drops it.`, ...(key ? { key } : {}) })}
              onClick={(e) => setPickKind(k, e.shiftKey ? 'toggle' : 'only')}
            >
              <Icon name={ICON[k]} size={16} />
            </button>
          )
        })}
      </div>
      <span className="select-pill-readout" data-testid="model-select-readout" aria-live="polite">
        {readout}
      </span>
      {anything ? (
        <button type="button" className="select-pill-clear" data-testid="model-select-clear" aria-label="Clear selection" {...tipAttrs({ title: 'Clear selection', key: 'Esc' })} onClick={() => set({ subPicks: [], selection: null, selectedIds: [] })}>
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  )
}
