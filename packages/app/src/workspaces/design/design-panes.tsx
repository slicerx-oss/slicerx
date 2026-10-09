// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Design panes, loaded as their own chunk when Design first opens. One side holds the tree of objects and
// their steps; the other holds the open tool (CAD tools and Cut) with the selected object's transform under it.
import { Block, Button, Icon, tipAttrs } from '@slicerx/ui'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useHost } from '../../host'
import { openModelFiles } from '../../state/actions'
import { isCadTool, selectedIds, set, useApp } from '../../state/store'
import { bounds, decompose, sizeOf, type Vec3 } from '../../plate/transform'
import { ObjectActions } from '../prepare/object-actions'
import { ObjectTransform } from '../prepare/object-transform'
import { HistoryTree } from './history-tree'
import { Timeline } from './timeline'
import { BottomPanel } from '../../shell/bottom-panel'
// Design closing parks the open tool and ends a step's rollback; the watch starts with Design.
import '../../cad/park'
import './design.css'

const CadPanel = lazy(() => import('../../cad/cad-panel').then((m) => ({ default: m.CadPanel })))
const CutPanel = lazy(() => import('../prepare/cut-panel').then((m) => ({ default: m.CutPanel })))

export function DesignLeft() {
  const host = useHost()
  const count = useApp((s) => s.plate.length)
  return (
    <Block aside={<span className="sx-small sx-muted">{count === 1 ? '1 object' : `${count} objects`}</span>} data-section="objects">
      <HistoryTree />
      <div className="plate-actions">
        <Button size="sm" variant="ghost" icon="plus" onClick={() => void openModelFiles(host)}>
          Add model
        </Button>
        <ObjectActions design />
      </div>
    </Block>
  )
}

export function DesignRight() {
  const objectTool = useApp((s) => s.objectTool)
  const selected = useApp((s) => s.plate.find((p) => p.id === s.selection)?.name ?? null)
  const many = useApp((s) => selectedIds(s).length > 1)
  // A history step opened for editing gets a fresh panel, even when the same tool is already open.
  const editKey = useApp((s) => (s.historyEdit ? `:${s.historyEdit.objectId}:${s.historyEdit.index}` : ''))
  const toolOpen = isCadTool(objectTool) || objectTool === 'cut'
  // While a tool is open, Transform folds to its position line so the tool keeps the room; it opens on request.
  const [transformOpen, setTransformOpen] = useState(false)
  useEffect(() => setTransformOpen(false), [objectTool])
  return (
    <>
      {isCadTool(objectTool) ? (
        <Suspense fallback={null}>
          <CadPanel key={objectTool + editKey} tool={objectTool} />
        </Suspense>
      ) : null}
      {objectTool === 'cut' ? (
        <Suspense fallback={null}>
          <CutPanel />
        </Suspense>
      ) : null}
      {many ? (
        <MultiSelection />
      ) : toolOpen && selected ? (
        <Block id="model-transform" title="Transform" aside={<TransformLine />} expanded={transformOpen} onExpandedChange={setTransformOpen} data-section="transform">
          <ObjectTransform />
        </Block>
      ) : (
        <Block title="Transform" aside={selected ? <span className="sx-small sx-muted">{selected}</span> : undefined} data-section="transform">
          {selected ? <ObjectTransform /> : <p className="sx-small sx-muted">Select an object to move, rotate or scale it.</p>}
        </Block>
      )}
    </>
  )
}

const fmt = (n: number) => String(Math.round(n * 10) / 10)

/** The selected object's position on one line, for Transform folded under a tool. */
function TransformLine() {
  const entry = useApp((s) => s.plate.find((p) => p.id === s.selection))
  if (!entry) return null
  const t = decompose(entry.transform)
  return (
    <span className="sx-small sx-muted design-tf-line" data-testid="model-transform-summary">
      X {fmt(t.position[0])} Y {fmt(t.position[1])} Z {fmt(t.position[2])} mm
    </span>
  )
}

/** Two or more objects selected: what they are, the room they take together, and a name to pick one alone. */
function MultiSelection() {
  const selection = useApp((s) => s.selection)
  const all = useApp((s) => s.selectedIds)
  const ids = selectedIds({ selection, selectedIds: all })
  const plate = useApp((s) => s.plate)
  const picked = ids.map((id) => plate.find((p) => p.id === id)).filter((e): e is NonNullable<typeof e> => e !== undefined)
  let box: { min: Vec3; max: Vec3 } | null = null
  for (const e of picked) {
    const b = bounds(e.parts, e.transform)
    if (!b) continue
    box = box ? { min: [0, 1, 2].map((i) => Math.min(box!.min[i]!, b.min[i]!)) as Vec3, max: [0, 1, 2].map((i) => Math.max(box!.max[i]!, b.max[i]!)) as Vec3 } : b
  }
  const size = box ? sizeOf(box) : null
  return (
    <Block title="Selection" aside={<span className="sx-small sx-muted">{`${picked.length} objects`}</span>} data-section="selection" data-testid="model-inspector-multi">
      {size ? (
        <p className="tf-readout" data-testid="model-multi-size">
          Together {fmt(size[0])} x {fmt(size[1])} x {fmt(size[2])} mm
        </p>
      ) : null}
      <ul className="design-multi" aria-label="Selected objects">
        {picked.map((e) => (
          <li key={e.id}>
            <button type="button" className="design-multi-row" data-testid="model-multi-object" data-object-id={e.id} {...tipAttrs({ title: `Select ${e.name} alone` })} onClick={() => set({ selection: e.id, selectedIds: [e.id] })}>
              <Icon name="cube" size={14} />
              <span>{e.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="sx-small sx-muted">Pick one to edit its numbers.</p>
    </Block>
  )
}

export { Shelf } from './shelf'
export { SelectPill } from './select-pill'

/** The timeline in its bottom panel. A step that breaks after an edit asks for attention. */
export function DesignTimeline() {
  const broken = useApp((s) => {
    const e = s.historyEdit?.original ?? s.plate.find((p) => p.id === s.selection)
    return e?.history?.steps.filter((st) => st.broken !== undefined && !st.suppressed).length ?? 0
  })
  const [attention, setAttention] = useState(0)
  const last = useRef(broken)
  useEffect(() => {
    if (broken > last.current) setAttention((n) => n + 1)
    last.current = broken
  }, [broken])
  return (
    <BottomPanel label="Timeline" memory="prepare-design:timeline" panel="model-timeline" attention={attention}>
      <Timeline />
    </BottomPanel>
  )
}
