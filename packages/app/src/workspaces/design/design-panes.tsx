// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Design panes, loaded as their own chunk when Design first opens. One side holds the tree of objects and
// their steps; the other holds the open tool (CAD tools and Cut) with the selected object's transform under it.
import { Block, Button } from '@slicerx/ui'
import { lazy, Suspense } from 'react'
import { useHost } from '../../host'
import { openModelFiles } from '../../state/actions'
import { isCadTool, useApp } from '../../state/store'
import { ObjectActions } from '../prepare/object-actions'
import { ObjectTransform } from '../prepare/object-transform'
import { HistoryTree } from './history-tree'
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
  // A history step opened for editing gets a fresh panel, even when the same tool is already open.
  const editKey = useApp((s) => (s.historyEdit ? `:${s.historyEdit.objectId}:${s.historyEdit.index}` : ''))
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
      <Block title="Transform" aside={selected ? <span className="sx-small sx-muted">{selected}</span> : undefined} data-section="transform">
        {selected ? <ObjectTransform /> : <p className="sx-small sx-muted">Select an object to move, rotate or scale it.</p>}
      </Block>
    </>
  )
}
