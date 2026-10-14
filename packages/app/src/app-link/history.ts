// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { replaying } from '../cad/history/ops'
import { history } from '../plate/history'
import { allPlates } from '../plate/plates'
import { bounds } from '../plate/transform'
import { toolStore } from '../plate/tools'
import { get, selectedIds, toast } from '../state/store'
import { LinkError } from './methods-error'

/** Project history read-back contains metadata and measurements, never mesh buffers. */
export function historyState() {
  const s = get()
  return {
    ...history().state(), activePlate: s.activePlate, selection: selectedIds(s),
    plates: allPlates(s).map((p) => ({
      id: p.id, name: p.name, settings: p.settings,
      objects: p.objects.map((o) => {
        const b = bounds(o.parts, o.transform)
        return {
          id: o.id, name: o.name, transform: o.transform, parts: o.parts.length,
          ...(b ? { minMm: b.min, maxMm: b.max, sizeMm: b.max.map((v, i) => v - b.min[i]!) } : {}),
          ...(o.history ? { steps: o.history.steps.map((step) => ({ id: step.id, label: step.label, op: step.params.op, suppressed: step.suppressed === true, ...(step.broken ? { broken: step.broken } : {}) })) } : {}),
        }
      }),
    })),
    objectSettings: s.objectSettings, filaments: s.slotSetup, flush: s.flush,
    timeline: { marker: s.timeline.marker, items: s.timeline.items.map((item) => ({ id: item.id, kind: item.kind, ...(item.kind === 'sketch' ? { name: item.name } : { body: item.body, op: item.params.op, label: item.label, suppressed: item.suppressed === true }) })) },
    rolledBack: s.rollback !== null,
  }
}

/** One toolbar Undo or Redo, provided the history read by the caller is still current. */
export function historyCall(method: string, args: Record<string, unknown>, client: string) {
  if (method === 'history.get') return historyState()
  if (typeof args['revision'] !== 'string' || !args['revision'] || Object.keys(args).some((key) => key !== 'revision')) throw new LinkError('invalid_input', 'Give the revision returned by app_history.')
  const s = get()
  if (s.plateLoading || s.liveEdit || s.historyEdit || s.objectTool || ['paint', 'brim', 'face'].includes(toolStore.getState().tool) || allPlates(s).some((p) => p.objects.some((o) => replaying(o.id)))) {
    throw new LinkError('busy', 'The project is loading or being edited; try again when the edit is finished.')
  }
  const h = history()
  if (args['revision'] !== h.state().revision) throw new LinkError('busy', 'The project history changed. Read app_history again before undoing or redoing.')
  const action = method === 'history.undo' ? 'undo' : 'redo'
  const changed = h[action]()
  if (changed) toast(`${client} ${action === 'undo' ? 'undid' : 'redid'} the last project edit.`, 'info')
  return { ...historyState(), action, changed }
}
