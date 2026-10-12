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
import { onControl } from '../controls/global-keys'
import { layerCountNow, stepLayer } from '../workspaces/preview/layer-step'
import { PICK_KINDS, pickKeysOn } from './pick-filter'
import { clearPicks, setPickKind } from './sub-pick'
import { arrangePlate, centerSelected, clearSelection, dropSelectedToBed, selectAll } from './edit'
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
    'tool.move': () => setTool('move', true),
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
    // The layer slider's keys, from anywhere in Slice. Stepping shows the toolpaths, as dragging the slider does.
    'preview.layerUp': () => layerKey(1),
    'preview.layerDown': () => layerKey(-1),
    // One layer: the bottom handle joins the top one; again, it goes back to the first layer.
    'preview.singleLayer': () =>
      set((s) => {
        const hi = Math.max(1, Math.min(s.layerHi, layerCountNow()))
        return { layerLo: s.layerLo >= hi ? 1 : hi, sliceLook: 'toolpaths' }
      }),
    'preview.legend': () => set((s) => ({ legendHidden: !s.legendHidden })),
  }
  for (const [action, preset] of Object.entries(VIEW) as [KeyAction, NonNullable<(typeof VIEW)[KeyAction]>][]) out[action] = () => bus()?.view?.(preset, { animate: true })
  return out
}

/** Focusable widgets that move with their own arrows: a panel's resize edge, a list, a menu, a toolbar. */
const OWNS_ARROWS = '[role=separator],[role=scrollbar],[role=spinbutton],[role=listbox],[role=tree],[role=treegrid],[role=grid],[role=menu],[role=menubar],[role=tablist],[role=radiogroup],[role=toolbar]'

function ownsArrows(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && target.closest(OWNS_ARROWS) !== null
}

function layerKey(by: number): void {
  if (get().sliceLook !== 'toolpaths') set({ sliceLook: 'toolpaths' })
  stepLayer(by)
}

/**
 * Whether a preview key acts now: Slice with a slice to step through, and not on a focused control (a radio, a select
 * or the layer slider itself keeps its own arrows). The layer arrows act on solid models too; the other preview keys
 * only while the toolpaths show, so a look that shares a letter (L for supports and for one layer) keeps the tool there.
 */
function previewKeyOn(action: KeyAction, s: ReturnType<typeof get>, e: KeyboardEvent): boolean {
  if (s.modelMode !== 'slice' || layerCountNow() < 1 || onControl(e.target) || ownsArrows(e.target)) return false
  return action === 'preview.layerUp' || action === 'preview.layerDown' || s.sliceLook === 'toolpaths'
}

/** Tools whose panel or gizmo takes Esc for itself. */
const TOOLS_WITH_ESC = new Set(['face', 'paint', 'brim', 'probe'])

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
    // A list that filters as you type (Model's tree) takes plain characters typed in it, before the single key tools.
    if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && e.target instanceof Element && e.target.closest('[data-typeahead]')) return
    // An open menu (the view's ring among them) keeps its own keys: Esc closes it before it clears any pick.
    if (e.target instanceof Element && e.target.closest('[role="menu"]')) return
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
    // Esc clears the selection in Slice while no tool is open; a menu, a popover, a phone's sheet or a tool panel keeps
    // its own Esc.
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && s.modelMode === 'slice' && s.objectTool === null && s.selection !== null && !TOOLS_WITH_ESC.has(toolStore.getState().tool)) {
      const t = e.target instanceof Element ? e.target : null
      if (!t?.closest('.tool-slot') && !document.querySelector('[role="menu"], [role="dialog"], .sx-popover, .pane.sheet-open')) return run(clearSelection)
    }
    const prepare = s.workspace === 'prepare'
    // Preview keys go first while they apply, so the layer slider's key wins over a tool on the same letter.
    for (const [action, h] of Object.entries(handlers) as [KeyAction, Handler][]) {
      const key = map[action]
      if (!key || !action.startsWith('preview.') || !previewKeyOn(action, s, e)) continue
      if (matchShortcut(e, chord(key))) return run(h)
    }
    for (const [action, h] of Object.entries(handlers) as [KeyAction, Handler][]) {
      const key = map[action]
      if (!key || action.startsWith('preview.')) continue
      // Tools act on the plate, so only in Prepare.
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
