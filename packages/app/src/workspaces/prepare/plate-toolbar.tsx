// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate toolbar over the viewport: tools, arrange, drop to bed, undo and redo. Tooltips name
// the key from the active look and feel's keymap. Placed on top or at the left per the preset.
import type { LayoutSpec } from '@slicerx/contracts'
import { Button } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { resolveConfig } from '../../adapters/config'
import { arrangePlate, dropSelectedToBed, getArrangeOptions, setArrangeOptions } from '../../plate/edit'
import { history } from '../../plate/history'
import { setTool, useTool } from '../../plate/tools'
import { useApp } from '../../state/store'
import { BRIM_TOOL, PLATE_TOOLS } from './plate-tool-list'

export function useHistoryCounts(): { undo: number; redo: number } {
  const [counts, setCounts] = useState(() => ({ undo: history().canUndo() ? 1 : 0, redo: history().canRedo() ? 1 : 0 }))
  useEffect(() => history().subscribe(setCounts), [])
  return counts
}

/** Gap and rotation for arrange, as in the reference slicers' arrange dialog. */
function ArrangeOptionsButton() {
  const [open, setOpen] = useState(false)
  const [opts, setOpts] = useState(getArrangeOptions)
  const update = (o: Partial<typeof opts>) => {
    setArrangeOptions(o)
    setOpts(getArrangeOptions())
  }
  return (
    <span className="arrange-opts">
      <Button variant="ghost" size="sm" icon="chevron-down" aria-label="Arrange options" aria-expanded={open} tip="plate.arrangeOptions" onClick={() => setOpen(!open)} />
      {open ? (
        <div className="arrange-pop sx-overlay" role="group" aria-label="Arrange options">
          <label className="tf-field" htmlFor="arrange-gap">
            <span className="tf-axis">Gap</span>
            <input id="arrange-gap" className="tf-input sx-mono" inputMode="decimal" defaultValue={opts.gapMm} onBlur={(e) => { const v = Number(e.target.value); if (v >= 0 && v <= 50) update({ gapMm: v }) }} />
            <span className="tf-unit">mm</span>
          </label>
          <label className="tf-lock">
            <input type="checkbox" checked={opts.rotate} onChange={(e) => update({ rotate: e.target.checked })} /> Allow rotation
          </label>
          <label className="tf-field" htmlFor="arrange-step">
            <span className="tf-axis">Turn step</span>
            <select id="arrange-step" className="mini" disabled={!opts.rotate} value={opts.stepDeg ?? 10} onChange={(e) => update({ stepDeg: Number(e.currentTarget.value) })}>
              {[5, 10, 15, 30, 45, 90].map((d) => <option key={d} value={d}>{d}°</option>)}
            </select>
          </label>
          <label className="tf-field" htmlFor="arrange-effort">
            <span className="tf-axis">Search</span>
            <select id="arrange-effort" className="mini" value={opts.effort ?? 'normal'} onChange={(e) => update({ effort: e.currentTarget.value as 'quick' | 'normal' | 'thorough' })}>
              <option value="quick">Quick</option>
              <option value="normal">Normal</option>
              <option value="thorough">Thorough</option>
            </select>
          </label>
          <span className="arrange-pop-act">
            <Button size="sm" onClick={() => { void arrangePlate('selection'); setOpen(false) }}>Arrange selection</Button>
            <Button size="sm" variant="primary" onClick={() => { void arrangePlate('all'); setOpen(false) }}>Arrange all</Button>
          </span>
        </div>
      ) : null}
    </span>
  )
}

export function PlateToolbar({ layout }: { layout: LayoutSpec }) {
  const tool = useTool()
  const hasSel = useApp((s) => s.selection !== null)
  const count = useApp((s) => s.plate.length)
  const { undo, redo } = useHistoryCounts()
  // The brim ears tool is offered while the brim type is painted, as in the reference slicers.
  const painted = useApp((s) => String(resolveConfig(s.easy, s.overrides)['brim_type'] ?? '') === 'painted')
  useEffect(() => {
    if (!painted && tool === 'brim') setTool('move')
  }, [painted, tool])
  return (
    <div className="plate-tools sx-overlay" role="toolbar" aria-label="Plate tools" data-placement={layout.toolbar} aria-orientation={layout.toolbar === 'left-of-viewport' ? 'vertical' : 'horizontal'}>
      {(painted ? [...PLATE_TOOLS, BRIM_TOOL] : PLATE_TOOLS).map((t) => (
        <Button key={t.tool} variant="ghost" size="sm" icon={t.icon} aria-label={t.label} tip={t.tip} pressed={tool === t.tool} onClick={() => setTool(tool === t.tool && t.tool !== 'move' ? 'move' : t.tool)} />
      ))}
      <span className="plate-tools-sep" aria-hidden="true" />
      {hasSel ? <Button variant="ghost" size="sm" icon="arrow-down" aria-label="Drop to bed" tip="plate.drop" onClick={() => dropSelectedToBed()} /> : null}
      <Button variant="ghost" size="sm" icon="arrange" aria-label="Arrange all" tip="plate.arrange" disabled={count === 0} onClick={() => void arrangePlate('all')} />
      <ArrangeOptionsButton />
      <span className="plate-tools-sep" aria-hidden="true" />
      <Button variant="ghost" size="sm" icon="undo" aria-label="Undo" tip="edit.undo" disabled={undo === 0} onClick={() => history().undo()} />
      <Button variant="ghost" size="sm" icon="redo" aria-label="Redo" tip="edit.redo" disabled={redo === 0} onClick={() => history().redo()} />
    </div>
  )
}
