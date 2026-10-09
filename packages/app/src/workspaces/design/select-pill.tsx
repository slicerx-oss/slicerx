// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's selection pill, at the top left of the view: what a click picks (objects, faces, edges), what is picked in
// plain words, and a way to clear it. The filter keys are Alt+1, Alt+2 and Alt+3, with Shift to add or drop a kind.
// With faces or edges on one object, its name selects the object alone; with one face, a crumb names the step that
// made it and opens that step.
import { Icon, keymapFor, tipAttrs } from '@slicerx/ui'
import { beginEdit, toolFor, viewStep } from '../../cad/history/ops'
import { stepName } from '../../cad/history/model'
import { useLookChoice } from '../../first-run/look'
import { useHost } from '../../host'
import { PICK_KINDS, PICK_LABEL, pickReadout, type PickKind } from '../../plate/pick-filter'
import { setPickKind } from '../../plate/sub-pick'
import { get, set, useApp } from '../../state/store'
import { useMadeBy } from './use-made-by'

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
  const host = useHost()
  const made = useMadeBy()
  // faces or edges all on one object
  const subOn = [...new Set(picks.map((p) => p.objectId))]
  const on1 = subOn.length === 1 && names[subOn[0]!] !== undefined ? { id: subOn[0]!, name: names[subOn[0]!]! } : null
  const madeStep = made && made.index >= 0 ? plate.find((p) => p.id === made.objectId)?.history?.steps[made.index] : undefined
  const openStep = (objectId: string, index: number) => {
    const step = get().plate.find((p) => p.id === objectId)?.history?.steps[index]
    if (!step) return
    void (toolFor(step.params) ? beginEdit(host.slicer, objectId, index) : viewStep(host.slicer, objectId, index)).catch(() => undefined)
  }
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
        {on1 && readout.endsWith(` on ${on1.name}`) ? (
          <>
            {readout.slice(0, -on1.name.length)}
            <button type="button" className="select-pill-crumb" data-testid="model-select-object" {...tipAttrs({ title: `Select ${on1.name}` })} onClick={() => set({ subPicks: [], selection: on1.id, selectedIds: [on1.id] })}>
              {on1.name}
            </button>
          </>
        ) : (
          readout
        )}
      </span>
      {made && made.objectId === on1?.id ? (
        made.index < 0 ? (
          <span className="select-pill-made" data-testid="model-select-made-by" data-step="base">
            from the original mesh
          </span>
        ) : (
          <button type="button" className="select-pill-made select-pill-crumb" data-testid="model-select-made-by" data-step={made.index} {...tipAttrs({ title: 'Open the step that made this face' })} onClick={() => openStep(made.objectId, made.index)}>
            made by {stepName(madeStep!)}
          </button>
        )
      ) : null}
      {anything ? (
        <button type="button" className="select-pill-clear" data-testid="model-select-clear" aria-label="Clear selection" {...tipAttrs({ title: 'Clear selection', key: 'Esc' })} onClick={() => set({ subPicks: [], selection: null, selectedIds: [] })}>
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  )
}
