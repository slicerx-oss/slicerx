// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer number in the playback bar. A click on it, or the look's jump key, opens a field over it: a layer number,
// or a height in mm, and Enter goes there. Esc or leaving the field closes it. The field opens over the readout, so
// nothing beside it moves.
import { keymapFor, tipAttrs } from '@slicerx/ui'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLookChoice } from '../../first-run/look'
import { set, useApp } from '../../state/store'
import { layerFromInput } from './layer-step'

export function LayerJump({ top, n, layerZ, onJump }: { top: number; n: number; layerZ: ArrayLike<number>; onJump: (layer: number) => void }) {
  const open = useApp((s) => s.layerJump)
  const choice = useLookChoice()
  const chord = keymapFor(choice.id, choice.overrides?.keys ?? {})['preview.jumpToLayer'] ?? undefined
  const [text, setText] = useState('')
  const [bad, setBad] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const width = `${String(n).length}ch`

  useLayoutEffect(() => {
    if (!open) return
    setText(String(top))
    setBad(false)
    field.current?.focus()
    field.current?.select()
    // only on opening: the number keeps what the person types
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  // a new slice or leaving Slice drops the bar; the field does not come back open with it
  useEffect(() => () => set({ layerJump: false }), [])

  const close = () => set({ layerJump: false })
  const go = () => {
    const k = layerFromInput(text, layerZ)
    if (k === null) return setBad(true)
    close()
    onJump(k)
  }

  return (
    <span className="dock-jump">
      Layer{' '}
      <span className="dock-jump-at">
        <button type="button" className="dock-jump-num" style={{ width }} aria-label={`Layer ${top} of ${n}. Jump to a layer`} {...tipAttrs({ title: 'Jump to a layer', body: 'Type a layer number, or a height such as 12.4 mm.', ...(chord ? { key: chord } : {}) })} onClick={() => set({ layerJump: true })}>
          {top}
        </button>
        {open ? (
          <input
            ref={field}
            className="dock-jump-field sx-mono"
            aria-label="Jump to a layer: a layer number, or a height in mm"
            aria-invalid={bad || undefined}
            data-testid="pv-layer-jump"
            value={text}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => (setText(e.target.value), setBad(false))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                go()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                close()
              }
            }}
            onBlur={close}
          />
        ) : null}
      </span>{' '}
      {/* hidden under the open field, so no digit shows past its edge and nothing moves */}
      <span className="dock-jump-of" style={open ? { visibility: 'hidden' } : undefined}>
        of {n}
      </span>
    </span>
  )
}
