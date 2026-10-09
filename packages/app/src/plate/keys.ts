// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate and camera keys from the active look and feel's keymap (docs/look-and-feel.md section 4),
// with the person's per-action overrides. Registered on window in the capture phase, so a key the
// keymap claims (Ctrl+1 is a view in the OrcaSlicer style) wins over the shell's workspace keys.
import type { LookAndFeelChoice } from '@slicerx/contracts'
import { keymapFor, type KeyAction } from '@slicerx/ui'
import { runCommand } from '../commands/registry'
import { inTextField, matchShortcut } from '../lib/keys'
import { toggleModelMode } from '../state/model-mode'
import { get, set } from '../state/store'
import { toggleEdge } from '../shell/edge-keys'
import { PICK_KINDS, pickKeysOn } from './pick-filter'
import { clearPicks, setPickKind } from './sub-pick'
import { arrangePlate, centerSelected, dropSelectedToBed, selectAll } from './edit'
import { history } from './history'
import { selectAllEars } from './brim-ears'
import { cameraBus, getPaintBus, setTool, toolStore } from './tools'

type Handler = () => void

const VIEW: Partial<Record<KeyAction, 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'bed'>> = {
  'view.plate': 'bed',
  'view.top': 'top',
  'view.bottom': 'bottom',
  'view.front': 'front',
  'view.back': 'back',
  'view.left': 'left',
  'view.right': 'right',
  'view.iso': 'iso',
}

/** Keymap chords use "Up" and "Down"; events say ArrowUp and ArrowDown. */
function chord(c: string): string {
  return c.replace(/\bUp$/, 'ArrowUp').replace(/\bDown$/, 'ArrowDown')
}

/** The key went to the 3D view: its canvas has focus. */
function inView(e: KeyboardEvent): boolean {
  const el = (e.target as Element | null) ?? document.activeElement
  return el instanceof HTMLCanvasElement && el.classList.contains('vp-canvas')
}

export function plateHandlers(): Partial<Record<KeyAction, Handler>> {
  const bus = () => cameraBus()
  const out: Partial<Record<KeyAction, Handler>> = {
    'tool.move': () => setTool('move'),
    'tool.rotate': () => setTool('rotate'),
    'tool.scale': () => setTool('scale'),
    'tool.placeOnFace': () => setTool('face'),
    'tool.supports': () => {
      setTool('paint')
      getPaintBus()?.set({ layer: 'support', state: 1 })
    },
    'view.zoomSelection': () => (get().selection ? bus()?.zoomToSelection?.({ animate: true }) : bus()?.view?.('fit', { animate: true })),
    'view.zoomBed': () => bus()?.zoomToBed?.({ animate: true }),
    'view.projection': () => void bus()?.toggleProjection?.(),
    'plate.arrange': () => void arrangePlate('all'),
    'plate.arrangeSelected': () => void arrangePlate('selection'),
    'edit.copy': () => void runCommand('copy'),
    'edit.cut': () => void runCommand('cut'),
    'edit.paste': () => void runCommand('paste'),
    'edit.duplicate': () => void runCommand('duplicate'),
    'object.printable': () => void runCommand('toggle-printable'),
    // Tab (in most looks) flips Slice between the toolpaths and the solid models.
    'workspace.toggle': () => set((s) => ({ workspace: 'prepare', modelMode: 'slice', sliceLook: s.workspace === 'prepare' && s.modelMode === 'slice' && s.sliceLook === 'toolpaths' ? 'solid' : 'toolpaths' })),
    'model.mode': toggleModelMode,
    // The panel on that side of the view with an edge tab: Model's tree and tool pane, Slice's sidebar and summary.
    'panel.left': () => void toggleEdge('left'),
    'panel.right': () => void toggleEdge('right'),
    'panel.bottom': () => void toggleEdge('bottom'),
  }
  for (const [action, preset] of Object.entries(VIEW) as [KeyAction, NonNullable<(typeof VIEW)[KeyAction]>][]) out[action] = () => bus()?.view?.(preset, { animate: true })
  return out
}

/** Undo and redo are the same in every preset. */
const FIXED: [string, Handler][] = [
  ['Mod+S', () => void runCommand('project-save')],
  ['Mod+A', () => (toolStore.getState().tool === 'brim' && get().selection ? selectAllEars(get().selection!) : selectAll())],
  ['Mod+Shift+Z', () => void history().redo()],
  ['Mod+Y', () => void history().redo()],
  ['Mod+Z', () => void history().undo()],
]

/** Binds the keys while Prepare or Preview is open. Returns the unbind. */
export function bindPlateKeys(choice: () => LookAndFeelChoice, extra: { dropToBed?: string; center?: string; onPaste?: (e: ClipboardEvent) => void } = {}): () => void {
  const handlers = plateHandlers()
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || inTextField(e)) return
    const s = get()
    if (s.setup || s.commandOpen || s.approval || s.aboutOpen || s.shortcutsOpen || s.settingsOpen) return
    if (s.workspace !== 'prepare') return
    // While sketching, a typed number opens the size field at the cursor; the view keys (1 is top) step aside.
    if (s.objectTool === 'sketch' && /^[0-9.\-]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) return
    const run = (h: Handler) => {
      e.preventDefault()
      e.stopPropagation()
      h()
    }
    for (const [c, h] of FIXED) if (matchShortcut(e, c)) return run(h)
    if (extra.dropToBed && matchShortcut(e, extra.dropToBed)) return run(() => void dropSelectedToBed())
    if (extra.center && matchShortcut(e, extra.center)) return run(() => void centerSelected())
    const c = choice()
    const map = keymapFor(c.id, c.overrides?.keys ?? {})
    // Model's pick filter: its key picks one kind, with Shift it adds or drops it. Esc drops faces and edges first.
    if (pickKeysOn(s)) {
      for (const kind of PICK_KINDS) {
        const key = map[`select.${kind}`]
        if (!key) continue
        if (matchShortcut(e, key)) return run(() => setPickKind(kind, 'only'))
        if (matchShortcut(e, `Shift+${key}`)) return run(() => setPickKind(kind, 'toggle'))
      }
      if (e.key === 'Escape' && s.subPicks.length) return run(() => void clearPicks())
    }
    const prepare = s.workspace === 'prepare'
    for (const [action, h] of Object.entries(handlers) as [KeyAction, Handler][]) {
      const key = map[action]
      if (!key) continue
      // Tools act on the plate, so only in Prepare; preview keys belong to the layer slider.
      if (!prepare && (action.startsWith('tool.') || action.startsWith('plate.'))) continue
      // A plain Tab is a view key only while the 3D view has focus; anywhere else it moves focus as usual.
      if (key === 'Tab' && !inView(e)) continue
      if (matchShortcut(e, chord(key))) {
        // Mod+V stays with the browser so its paste event can carry files from the system clipboard.
        if (action === 'edit.paste' && /^Mod\+V$/i.test(key)) return
        return run(h)
      }
    }
  }
  // The browser's paste event: model files on the system clipboard first, else what was copied in the app.
  const onPaste = (e: ClipboardEvent) => {
    if (inTextField(e as unknown as KeyboardEvent)) return
    const s = get()
    if (s.setup || s.commandOpen || s.approval || s.aboutOpen || s.shortcutsOpen || s.settingsOpen) return
    if (s.workspace !== 'prepare') return
    e.preventDefault()
    if (extra.onPaste) extra.onPaste(e)
    else void runCommand('paste')
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('paste', onPaste, true)
  return () => {
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('paste', onPaste, true)
  }
}
