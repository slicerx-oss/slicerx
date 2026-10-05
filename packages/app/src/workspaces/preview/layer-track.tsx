// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Preview layer slider with its marks: a + and a right-click menu add a pause, a color change or custom
// G-code at the start of the current layer (Orca and Bambu Studio, IMSlider.cpp), marks sit on the track, and a
// click on one deletes or edits it. The marks go into the next slice as layer G-code.
import { Button, Dialog, Field, Icon, Menu, MenuAnchor, MenuItem, MenuSeparator, Range, Textarea, tipAttrs, type IconName } from '@slicerx/ui'
import { useState, type KeyboardEvent } from 'react'
import { addMark, customGcodeProblem, MARK_LABEL, removeMark, type LayerMark, type MarkKind } from '../../plate/layer-marks'
import { toast, useApp } from '../../state/store'

const EMPTY: LayerMark[] = []
const ICON: Record<MarkKind, IconName> = { pause: 'pause-marker', color_change: 'color-change-marker', custom: 'terminal' }
const HINT: Record<MarkKind, string> = {
  pause: 'Insert a pause command at the beginning of this layer.',
  color_change: 'Stop at the beginning of this layer so you can change the filament.',
  custom: 'Insert custom G-code at the beginning of this layer.',
}

/** Layer number (1-based) a mark sits on: the first layer whose top reaches its height. */
function layerOf(m: LayerMark, layerZ: ArrayLike<number>): number {
  for (let i = 0; i < layerZ.length; i++) if ((layerZ[i] ?? 0) >= m.z - 1e-6) return i + 1
  return layerZ.length
}

export function LayerTrack({ id, n, top, layerZ, onChange, onKeyDown }: { id: string; n: number; top: number; layerZ: ArrayLike<number>; onChange: (layer: number) => void; onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void }) {
  const plateId = useApp((s) => s.activePlate)
  const marks = useApp((s) => s.layerMarks[plateId]) ?? EMPTY
  const [menu, setMenu] = useState<string | null>(null)
  const [custom, setCustom] = useState<{ text: string; z: number } | null>(null)
  const z = layerZ[top - 1] ?? 0
  const here = marks.find((m) => Math.abs(m.z - z) < 1e-6)
  const add = (kind: MarkKind) => {
    setMenu(null)
    if (kind === 'custom') return setCustom({ text: '', z })
    addMark(z, kind)
    toast(`${MARK_LABEL[kind]} added at layer ${top}. Slice again to put it in the file.`, 'info')
  }
  const problem = custom ? customGcodeProblem(custom.text) : null
  const share = (layer: number) => (n > 1 ? ((layer - 1) / (n - 1)) * 100 : 0)
  return (
    <div className="layer-track" onContextMenu={(e) => { e.preventDefault(); setMenu('add') }}>
      <div className="layer-track-rail">
        <Range id={id} className="thin" min={1} max={n} value={top} onChange={onChange} onKeyDown={onKeyDown} aria-valuetext={`Layer ${top} of ${n}, ${z.toFixed(2)} mm`} />
        <div className="layer-marks">
          {marks.map((m) => {
            const layer = layerOf(m, layerZ)
            return (
              <button key={m.id} type="button" className="layer-mark" data-kind={m.kind} style={{ left: `${share(layer)}%` }} aria-label={`${MARK_LABEL[m.kind]} at layer ${layer}`} {...tipAttrs({ title: `${MARK_LABEL[m.kind]}, layer ${layer}`, body: m.kind === 'custom' ? (m.gcode ?? '').split('\n')[0]!.slice(0, 60) : 'Click to change or delete it.' })} onClick={() => { onChange(layer); setMenu('add') }}>
                <Icon name={ICON[m.kind]} size={14} />
              </button>
            )
          })}
        </div>
      </div>
      <MenuAnchor>
        <Button variant="ghost" size="sm" icon="plus" aria-haspopup="menu" aria-expanded={menu === 'add'} aria-label="Add at this layer" tip={{ title: 'Add at this layer', body: 'Pause, change the color or insert G-code here. Right-click the slider too.' }} onClick={() => setMenu(menu === 'add' ? null : 'add')} />
        <Menu open={menu === 'add'} onClose={() => setMenu(null)} label={`Layer ${top} marks`} align="end">
          {here ? (
            <>
              {here.kind === 'custom' ? (
                <MenuItem icon="rename" onClick={() => { setMenu(null); setCustom({ text: here.gcode ?? '', z }) }}>
                  Edit custom G-code
                </MenuItem>
              ) : null}
              <MenuItem icon="delete" onClick={() => { removeMark(here.id); setMenu(null) }}>
                {here.kind === 'pause' ? 'Delete pause' : here.kind === 'color_change' ? 'Delete color change' : 'Delete custom G-code'}
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem icon="pause-marker" {...tipAttrs({ title: 'Add pause', body: HINT.pause })} onClick={() => add('pause')}>
                Add pause
              </MenuItem>
              <MenuItem icon="color-change-marker" {...tipAttrs({ title: 'Add color change', body: HINT.color_change })} onClick={() => add('color_change')}>
                Add color change
              </MenuItem>
              <MenuItem icon="terminal" {...tipAttrs({ title: 'Add custom G-code', body: HINT.custom })} onClick={() => add('custom')}>
                Add custom G-code
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          <MenuItem disabled>Layer {top}, {z.toFixed(2)} mm</MenuItem>
        </Menu>
      </MenuAnchor>
      <Dialog
        open={custom !== null}
        onClose={() => setCustom(null)}
        title={`Custom G-code at layer ${top}`}
        footer={
          <>
            <Button onClick={() => setCustom(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={problem !== null}
              onClick={() => {
                if (!custom) return
                try {
                  addMark(custom.z, 'custom', custom.text)
                  toast('Custom G-code added. Slice again to put it in the file.', 'info')
                  setCustom(null)
                } catch (e) {
                  toast(e instanceof Error ? e.message : 'Could not add it', 'error')
                }
              }}
            >
              Add
            </Button>
          </>
        }
      >
        <Field htmlFor="mark-gcode" label="G-code" hint="Runs at the start of this layer. The engine checks it again when it writes the file." {...(custom && custom.text && problem ? { error: problem } : {})}>
          <Textarea id="mark-gcode" rows={5} spellCheck={false} className="sx-mono" value={custom?.text ?? ''} onChange={(e) => setCustom(custom ? { ...custom, text: e.target.value } : custom)} />
        </Field>
      </Dialog>
    </div>
  )
}
