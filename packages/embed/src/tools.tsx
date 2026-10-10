// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Prepare toolbar over the embedded view: the tools, then arrange and drop to bed. Every button keeps its place
// and size whatever is picked, and drop is never hidden: with nothing selected it sets every object down.
import { Icon, type IconName } from '@slicerx/ui'

/** A tool that stays on: what a press on a model does. */
export type EmbedTool = 'select' | 'move' | 'rotate' | 'scale'
/** A toolbar button: a tool, or one of the two plate actions. */
export type EmbedAction = EmbedTool | 'arrange' | 'drop'

export const EMBED_ACTIONS: readonly EmbedAction[] = ['select', 'move', 'rotate', 'scale', 'arrange', 'drop']

const SPEC: Record<EmbedAction, { label: string; icon: IconName; key: string | null; tip: string }> = {
  select: { label: 'Select', icon: 'select-object', key: null, tip: 'Click a model to select it' },
  move: { label: 'Move', icon: 'move', key: 'M', tip: 'Drag a model across the plate' },
  rotate: { label: 'Rotate', icon: 'rotate', key: 'R', tip: 'Drag a ring to turn the selected model' },
  scale: { label: 'Scale', icon: 'scale', key: 'S', tip: 'Drag a handle to resize the selected model. Several models scale evenly, from the corner handles' },
  arrange: { label: 'Arrange', icon: 'arrange', key: 'A', tip: 'Spread every model out on the plate' },
  drop: { label: 'Drop to bed', icon: 'arrow-down', key: null, tip: 'Set the selection, or every model, down on the bed' },
}

export const toolKey = (a: EmbedAction): string | null => SPEC[a].key

const isTool = (a: EmbedAction): a is EmbedTool => a !== 'arrange' && a !== 'drop'

export function PrepareTools({ actions, tool, onAction }: { actions: readonly EmbedAction[]; tool: EmbedTool; onAction: (a: EmbedAction) => void }) {
  const tools = actions.filter(isTool)
  const plate = actions.filter((a) => !isTool(a))
  const button = (a: EmbedAction) => {
    const s = SPEC[a]
    return (
      <button
        key={a}
        type="button"
        className="sxe-tool"
        aria-label={s.label}
        title={s.key ? `${s.label} (${s.key}). ${s.tip}` : `${s.label}. ${s.tip}`}
        {...(isTool(a) ? { 'aria-pressed': a === tool } : {})}
        onClick={() => onAction(a)}
      >
        <Icon name={s.icon} size={18} />
      </button>
    )
  }
  return (
    <div className="sxe-tools" role="toolbar" aria-label="Plate tools">
      {tools.map(button)}
      {tools.length && plate.length ? <span className="sxe-tools-sep" aria-hidden="true" /> : null}
      {plate.map(button)}
    </div>
  )
}
